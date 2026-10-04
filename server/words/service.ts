// Finds or creates word lists, generating them with OpenAI when possible.
import type { Difficulty } from "../../shared/protocol.ts";
import { config } from "../config.ts";
import type { Repo, WordListRow } from "../db.ts";
import { BUILTIN_WORDS } from "./builtin.ts";
import { generateWords, wordGenAvailable } from "./generate.ts";
import { normalizeText } from "./matcher.ts";

export function listLabel(list: Pick<WordListRow, "theme" | "difficulty" | "source">): string {
  if (list.source === "builtin") return "Built-in words";
  return `${list.theme || "General"} · ${list.difficulty}`;
}

export class WordLists {
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private repo: Repo) {}

  /** Returns an existing list for the theme + difficulty, or creates one. */
  async ensureList(theme: string, difficulty: Difficulty): Promise<WordListRow> {
    const themeKey = normalizeText(theme);
    const useBuiltin = !wordGenAvailable() && themeKey === "";
    if (!useBuiltin && !wordGenAvailable()) {
      throw new Error("Custom themes need OPENAI_API_KEY on the server");
    }
    const lookupKey = useBuiltin ? "" : themeKey;
    const lookupDifficulty = useBuiltin ? "medium" : difficulty;
    const existing = this.repo.findWordList(lookupKey, lookupDifficulty);
    const source = useBuiltin ? "builtin" : "openai";
    if (existing && existing.source === source) return existing;

    return this.once(`list:${source}:${lookupKey}:${lookupDifficulty}`, async () => {
      const again = this.repo.findWordList(lookupKey, lookupDifficulty);
      if (again && again.source === source) return again;
      const words = useBuiltin
        ? BUILTIN_WORDS.map((word) => ({ word, variants: [] }))
        : await generateWords({ theme, difficulty, count: config.wordsPerList, exclude: [] });
      const id = this.repo.createWordList(theme, lookupKey, lookupDifficulty, source, useBuiltin ? null : config.openaiModel);
      this.repo.addWords(id, words.map((w) => ({ ...w, norm: normalizeText(w.word) })));
      return this.repo.wordList(id)!;
    });
  }

  /** Generates more words for a list, avoiding everything already in it or used. */
  async topUp(list: WordListRow, alsoExclude: string[]): Promise<number> {
    if (list.source === "builtin" || !wordGenAvailable()) return 0;
    return this.once(`topup:${list.id}`, async () => {
      const existing = this.repo.listWords(list.id).map((w) => w.word);
      const exclude = [...new Set([...existing, ...alsoExclude])].slice(-600);
      const words = await generateWords({
        theme: list.theme,
        difficulty: list.difficulty,
        count: config.wordsPerList,
        exclude,
      });
      return this.repo.addWords(list.id, words.map((w) => ({ ...w, norm: normalizeText(w.word) })));
    });
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
