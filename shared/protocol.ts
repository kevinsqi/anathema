// Types and schemas shared by the server and the web client.
import { z } from "zod";

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export type Phase = "lobby" | "playing" | "resetting" | "finished";

/** How a word left play. */
export type WordOutcome = "guessed" | "fouled" | "skipped" | "timeout" | "abandoned";

export type ScoreSource = "auto" | "manual";

export interface Settings {
  targetScore: number;
  /** Seconds a describer can hold the seat without a correct guess before a reset. */
  turnSeconds: number;
  resetCountdownSeconds: number;
  skipPenalty: number;
  foulPenalty: number;
  autoDetect: boolean;
  theme: string;
  difficulty: Difficulty;
}

export const DEFAULT_SETTINGS: Settings = {
  targetScore: 10,
  turnSeconds: 180,
  resetCountdownSeconds: 5,
  skipPenalty: 0.5,
  foulPenalty: 1,
  autoDetect: true,
  theme: "",
  difficulty: "medium",
};

export interface PublicPlayer {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  micOn: boolean;
}

export interface RevealedWord {
  word: string;
  outcome: WordOutcome;
  /** Who guessed / fouled / skipped it. */
  playerId: string | null;
  source: ScoreSource | null;
  at: number;
}

export interface WordListStatus {
  status: "ready" | "generating" | "error";
  label: string;
  remaining: number;
  error?: string;
}

export interface PublicState {
  code: string;
  phase: Phase;
  hostId: string;
  players: PublicPlayer[];
  describerId: string | null;
  /** True while the describer is waiting on more words to be generated. */
  waitingForWord: boolean;
  turnStartedAt: number | null;
  resetEndsAt: number | null;
  winnerId: string | null;
  settings: Settings;
  wordList: WordListStatus;
  recent: RevealedWord[];
  canUndo: boolean;
  sttAvailable: boolean;
  wordGenAvailable: boolean;
}

export interface SecretWord {
  word: string;
  variants: string[];
}

export type ServerMessage =
  | { t: "state"; state: PublicState; you: string; word: SecretWord | null; serverNow: number }
  | { t: "caption"; playerId: string; text: string; final: boolean; matched: boolean }
  | { t: "toast"; text: string }
  | { t: "error"; message: string };

export const SettingsPatch = z
  .object({
    targetScore: z.number().int().min(1).max(100),
    turnSeconds: z.number().int().min(30).max(1800),
    autoDetect: z.boolean(),
    theme: z.string().trim().max(120),
    difficulty: z.enum(DIFFICULTIES),
  })
  .partial();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const ClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("start") }),
  z.object({ t: z.literal("settings"), patch: SettingsPatch }),
  z.object({ t: z.literal("guessed"), playerId: z.string() }),
  z.object({ t: z.literal("foul") }),
  z.object({ t: z.literal("skip") }),
  z.object({ t: z.literal("undo") }),
  z.object({ t: z.literal("endGame") }),
  z.object({ t: z.literal("mic"), on: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const NameSchema = z.string().trim().min(1).max(24);
export const CodeSchema = z.string().regex(/^\d{5}$/);

export interface JoinResponse {
  code: string;
  playerId: string;
  token: string;
}

/** Audio the client streams for speech-to-text: mono 16-bit PCM. */
export const STT_SAMPLE_RATE = 16000;
