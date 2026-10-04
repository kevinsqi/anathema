// Generates themed word lists with the OpenAI API.
import OpenAI from "openai";
import type { Difficulty } from "../../shared/protocol.ts";
import { config } from "../config.ts";
import { buildForms, normalizeText, textMatches, type WordForms } from "./matcher.ts";

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

/** Words per request. Smaller batches in parallel return much faster than one big one. */
const BATCH_SIZE = 25;
/**
 * Initial letters, most to least common, dealt round-robin so every batch gets a
 * fair mix. J, K, Q, X, Y and Z are left out: batches forced to cover them pad
 * with junk like "Xenophile".
 */
const LETTERS_BY_FREQUENCY = "SCPDMABTRFEHIGLWOUNV";

export async function generateWords(opts: {
  theme: string;
  difficulty: Difficulty;
  count: number;
  exclude: string[];
}): Promise<GeneratedWord[]> {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not set");
  client ??= new OpenAI({ apiKey: config.openaiApiKey });

  // Each batch gets its own slice of the alphabet so parallel batches don't
  // all come back with the same obvious picks.
  const batches = Math.max(1, Math.ceil(opts.count / BATCH_SIZE));
  const results = await Promise.allSettled(
    Array.from({ length: batches }, (_, i) => {
      const letters = batches > 1 ? [...LETTERS_BY_FREQUENCY].filter((_, j) => j % batches === i).sort() : null;
      // Ask for a little extra since batches may come back short rather than pad with weak words.
      return generateBatch({ ...opts, count: Math.ceil((opts.count * 1.2) / batches) }, letters);
    }),
  );

  const seen = new Set(opts.exclude.map(normalizeText));
  const kept: { word: GeneratedWord; forms: WordForms }[] = [];
  for (const r of results) {
    if (r.status === "rejected") continue;
    for (const raw of r.value) {
      const word = { ...raw, word: raw.word.replace(/\s*\([^)]*\)/g, "").trim() };
      const norm = normalizeText(word.word);
      if (!norm || seen.has(norm)) continue;
      // Skip words overlapping one already kept ("verses"/"verse", "vinyl record"/"vinyl"):
      // a describer working on one would be penalized for saying the other.
      const forms = buildForms(word.word, word.variants);
      const overlaps = kept.some((k) => textMatches(word.word, k.forms) || textMatches(k.word.word, forms));
      if (overlaps) continue;
      seen.add(norm);
      kept.push({ word, forms });
    }
  }
  const words = kept.map((k) => k.word);
  if (words.length === 0) {
    const failure = results.find((r) => r.status === "rejected");
    throw failure ? failure.reason : new Error("OpenAI returned no words");
  }
  return words;
}

async function generateBatch(
  opts: { theme: string; difficulty: Difficulty; count: number; exclude: string[] },
  letters: string[] | null,
): Promise<GeneratedWord[]> {
  const theme = opts.theme || "general vocabulary, any topic";
  const prompt = [
    `Generate ${opts.count} distinct words or short phrases (1-3 words) for a party game like Taboo.`,
    `One player describes the word without saying it and the others shout guesses.`,
    `Theme: ${theme}`,
    `Difficulty: ${opts.difficulty} — ${DIFFICULTY_GUIDE[opts.difficulty]}.`,
    letters ? `Only use words that start with one of these letters: ${letters.join(", ")}.` : "",
    `Quality matters more than count: return fewer words rather than padding with weak or off-theme ones.`,
    `Pick words that are fun to describe and that a guesser could say out loud unambiguously.`,
    `Write each word plainly, with no parentheses or explanations.`,
    `Avoid obscure proper nouns unless the theme calls for them.`,
    `For each word, list "variants": close forms that should count as saying the word — singular/plural,`,
    `verb tenses, -ing forms, common alternate spellings, and derivatives that share the root`,
    `(e.g. "flames" → ["flame", "flaming", "flamed"]). Do not repeat the word itself in variants.`,
    `For proper nouns (people, bands, places, brands), variants are only alternate names or nicknames`,
    `(e.g. "Beatles" → ["Beatle", "Fab Four"]); never invent derivatives like "queenly" for "Queen".`,
    opts.exclude.length > 0 ? `Do not use any of these words: ${opts.exclude.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await client!.chat.completions.create({
    model: config.openaiModel,
    reasoning_effort: config.openaiReasoningEffort,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_schema", json_schema: { name: "word_list", strict: true, schema: SCHEMA } },
  });
  const content = res.choices[0]?.message.content;
  if (!content) throw new Error("OpenAI returned no content");
  const parsed = JSON.parse(content) as { words: GeneratedWord[] };
  return parsed.words.filter((w) => w.word.trim().length > 0);
}
