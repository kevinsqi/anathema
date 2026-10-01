// Generates themed word lists with the OpenAI API.
import OpenAI from "openai";
import type { Difficulty } from "../../shared/protocol.ts";
import { config } from "../config.ts";

export interface GeneratedWord {
  word: string;
  variants: string[];
}

const DIFFICULTY_GUIDE: Record<Difficulty, string> = {
  easy: "common, everyday words most 10-year-olds know",
  medium: "words well known to most adults that take a little thought to describe",
  hard: "advanced or specialized vocabulary (SAT/GRE level, or deep cuts within the theme) that can still be described aloud",
};

const SCHEMA = {
  type: "object",
  properties: {
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          variants: { type: "array", items: { type: "string" } },
        },
        required: ["word", "variants"],
        additionalProperties: false,
      },
    },
  },
  required: ["words"],
  additionalProperties: false,
} as const;

let client: OpenAI | null = null;

export function wordGenAvailable(): boolean {
  return Boolean(config.openaiApiKey);
}

export async function generateWords(opts: {
  theme: string;
  difficulty: Difficulty;
  count: number;
  exclude: string[];
}): Promise<GeneratedWord[]> {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not set");
  client ??= new OpenAI({ apiKey: config.openaiApiKey });

  const theme = opts.theme || "general vocabulary, any topic";
  const prompt = [
    `Generate ${opts.count} distinct words or short phrases (1-3 words) for a party game like Taboo.`,
    `One player describes the word without saying it and the others shout guesses.`,
    `Theme: ${theme}`,
    `Difficulty: ${opts.difficulty} — ${DIFFICULTY_GUIDE[opts.difficulty]}.`,
    `Pick words that are fun to describe and that a guesser could say out loud unambiguously.`,
    `Avoid obscure proper nouns unless the theme calls for them.`,
    `For each word, list "variants": close forms that should count as saying the word — singular/plural,`,
    `verb tenses, -ing forms, common alternate spellings, and derivatives that share the root`,
    `(e.g. "flames" → ["flame", "flaming", "flamed"]). Do not repeat the word itself in variants.`,
    opts.exclude.length > 0 ? `Do not use any of these words: ${opts.exclude.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await client.chat.completions.create({
    model: config.openaiModel,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_schema", json_schema: { name: "word_list", strict: true, schema: SCHEMA } },
  });
  const content = res.choices[0]?.message.content;
  if (!content) throw new Error("OpenAI returned no content");
  const parsed = JSON.parse(content) as { words: GeneratedWord[] };
  return parsed.words.filter((w) => w.word.trim().length > 0);
}
