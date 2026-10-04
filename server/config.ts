import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  production: env.NODE_ENV === "production",
  dbPath: env.DB_PATH ?? "data/anathema.db",
  openaiApiKey: env.OPENAI_API_KEY || null,
  openaiModel: env.OPENAI_MODEL || "gpt-5-mini",
  // Picking words needs little reasoning; higher effort made a 100-word list take ~75s.
  openaiReasoningEffort: (env.OPENAI_REASONING_EFFORT || "minimal") as "minimal" | "low" | "medium" | "high",
  deepgramApiKey: env.DEEPGRAM_API_KEY || null,
  deepgramModel: env.DEEPGRAM_MODEL || "nova-3",
  deepgramUrl: env.DEEPGRAM_URL || "wss://api.deepgram.com/v1/listen",
  sttMinConfidence: Number(env.STT_MIN_CONFIDENCE ?? 0.5),
  wordsPerList: 100,
};
