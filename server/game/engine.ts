// The game rules as a deterministic state machine. Persistence, sockets and
// speech-to-text live elsewhere; they drive this class and drain its effects.
import {
  DEFAULT_SETTINGS,
  type Phase,
  type RevealedWord,
  type ScoreSource,
  type Settings,
  type SettingsPatch,
  type WordOutcome,
} from "../../shared/protocol.ts";

export interface WordEntry {
  id: number;
  word: string;
  variants: string[];
}

export interface PlayerState {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  disconnectedAt: number | null;
  micOn: boolean;
}

interface UndoEntry {
  label: string;
  scores: Record<string, number>;
  describerId: string | null;
  word: WordEntry | null;
  turnStartedAt: number | null;
  phase: Phase;
  winnerId: string | null;
  recent: RevealedWord[];
}

export interface EngineState {
  phase: Phase;
  hostId: string;
  players: PlayerState[];
  describerId: string | null;
  word: WordEntry | null;
  turnStartedAt: number | null;
  resetEndsAt: number | null;
  winnerId: string | null;
  settings: Settings;
  recent: RevealedWord[];
  undoStack: UndoEntry[];
}

export type ScoreKind = "guess" | "foul" | "skip" | "undo";

export type GameEffect =
  | { type: "score"; playerId: string; kind: ScoreKind; delta: number; word: string | null; source: ScoreSource }
  | { type: "wordFinished"; wordId: number; outcome: WordOutcome; playerId: string | null }
  /** A word came back into play via undo, so it is no longer finished. */
  | { type: "wordRestored"; wordId: number }
  /** A word was drawn but undo removed it before it was really played. */
  | { type: "wordReleased"; wordId: number }
  | { type: "gameStarted" }
  | { type: "gameEnded"; winnerId: string | null }
  | { type: "gameResumed" }
  | { type: "needWord" }
  | { type: "toast"; text: string };

export interface EngineDeps {
  now: () => number;
  random: () => number;
  /** Returns an unused word for this lobby, or null if the pool is empty. */
  drawWord: () => WordEntry | null;
}

export class GameError extends Error {}

const MAX_UNDO = 10;
const MAX_RECENT = 12;
/** How long a disconnected describer keeps the seat before it passes on. */
export const DESCRIBER_GRACE_MS = 15_000;

export function initialState(hostId: string, settings: Settings = DEFAULT_SETTINGS): EngineState {
  return {
    phase: "lobby",
    hostId,
    players: [],
    describerId: null,
    word: null,
    turnStartedAt: null,
    resetEndsAt: null,
    winnerId: null,
    settings: { ...settings },
    recent: [],
    undoStack: [],
  };
}

export class Game {
  private effects: GameEffect[] = [];

  constructor(
    public state: EngineState,
    private deps: EngineDeps,
  ) {}

  drainEffects(): GameEffect[] {
    const out = this.effects;
    this.effects = [];
    return out;
  }

  player(id: string): PlayerState | undefined {
    return this.state.players.find((p) => p.id === id);
  }

  private mustPlayer(id: string): PlayerState {
    const p = this.player(id);
    if (!p) throw new GameError("Unknown player");
    return p;
  }

  private name(id: string | null): string {
    return (id && this.player(id)?.name) || "someone";
  }

  // --- Players & settings -------------------------------------------------

  addPlayer(id: string, name: string): void {
    if (this.player(id)) return;
    this.state.players.push({ id, name, score: 0, connected: false, disconnectedAt: null, micOn: false });
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.mustPlayer(id);
    if (p.connected === connected) return;
    p.connected = connected;
    p.disconnectedAt = connected ? null : this.deps.now();
    if (!connected) p.micOn = false;
  }

  setMic(id: string, on: boolean): void {
    this.mustPlayer(id).micOn = on;
  }

  /** The host, or anyone if the host has dropped off. */
  isHostLike(id: string): boolean {
    const host = this.player(this.state.hostId);
    return id === this.state.hostId || !host?.connected;
  }

  updateSettings(patch: SettingsPatch): void {
    const wordListChanged =
      (patch.theme !== undefined && patch.theme !== this.state.settings.theme) ||
      (patch.difficulty !== undefined && patch.difficulty !== this.state.settings.difficulty);
    if (wordListChanged && this.inGame()) {
      throw new GameError("Can't change the word list mid-game");
    }
    Object.assign(this.state.settings, patch);
  }

  inGame(): boolean {
    return this.state.phase === "playing" || this.state.phase === "resetting";
  }

  // --- Game flow ----------------------------------------------------------

  start(): void {
    if (this.inGame()) throw new GameError("Game already running");
    const connected = this.connectedPlayers();
    if (connected.length < 2) throw new GameError("Need at least 2 connected players");
    for (const p of this.state.players) p.score = 0;
    this.state.recent = [];
    this.state.undoStack = [];
    this.state.winnerId = null;
    this.state.resetEndsAt = null;
    this.state.phase = "playing";
    this.effects.push({ type: "gameStarted" });
    this.seat(this.pick(connected).id);
    this.toast(`${this.name(this.state.describerId)} describes first`);
  }

  endGame(): void {
    if (!this.inGame()) throw new GameError("No game running");
    this.finishWord("abandoned", null, null);
    this.state.phase = "lobby";
    this.state.describerId = null;
    this.state.turnStartedAt = null;
    this.state.resetEndsAt = null;
    this.state.undoStack = [];
    this.effects.push({ type: "gameEnded", winnerId: null });
  }

  correctGuess(guesserId: string, source: ScoreSource): void {
    this.requireWord();
    if (guesserId === this.state.describerId) throw new GameError("The describer can't guess");
    const guesser = this.mustPlayer(guesserId);
    const word = this.state.word!;
    this.pushUndo(`${guesser.name} guessed ${word.word}`);

    guesser.score += 1;
    this.effects.push({ type: "score", playerId: guesserId, kind: "guess", delta: 1, word: word.word, source });
    this.finishWord("guessed", guesserId, source);
    this.toast(`${guesser.name} guessed “${word.word}”${source === "auto" ? " (auto)" : ""}`);

    if (guesser.score >= this.state.settings.targetScore) {
      this.state.phase = "finished";
      this.state.winnerId = guesserId;
      this.state.describerId = null;
      this.state.turnStartedAt = null;
      this.effects.push({ type: "gameEnded", winnerId: guesserId });
      this.toast(`${guesser.name} wins!`);
      return;
    }
    this.seat(guesserId);
  }

  foul(source: ScoreSource): void {
    this.penalize("foul", "fouled", this.state.settings.foulPenalty, source);
  }

  skip(): void {
    this.penalize("skip", "skipped", this.state.settings.skipPenalty, "manual");
  }

  private penalize(kind: "foul" | "skip", outcome: WordOutcome, penalty: number, source: ScoreSource): void {
    this.requireWord();
    const describer = this.mustPlayer(this.state.describerId!);
    const word = this.state.word!;
    this.pushUndo(`${describer.name} ${outcome} ${word.word}`);

    describer.score -= penalty;
    this.effects.push({ type: "score", playerId: describer.id, kind, delta: -penalty, word: word.word, source });
    this.finishWord(outcome, describer.id, source);
    this.toast(
      kind === "foul"
        ? `${describer.name} said “${word.word}”! −${penalty}${source === "auto" ? " (auto)" : ""}`
        : `${describer.name} skipped “${word.word}” −${penalty}`,
    );
    // Same describer, fresh word; the seat timer keeps running.
    this.assignWord();
  }

  undo(): void {
    const entry = this.state.undoStack.pop();
    if (!entry) throw new GameError("Nothing to undo");

    for (const p of this.state.players) {
      const before = entry.scores[p.id] ?? 0;
      if (p.score !== before) {
        this.effects.push({ type: "score", playerId: p.id, kind: "undo", delta: before - p.score, word: null, source: "manual" });
        p.score = before;
      }
    }
    if (this.state.word && this.state.word.id !== entry.word?.id) {
      this.effects.push({ type: "wordReleased", wordId: this.state.word.id });
    }
    if (entry.word) this.effects.push({ type: "wordRestored", wordId: entry.word.id });
    if (this.state.phase === "finished" && entry.phase !== "finished") {
      this.effects.push({ type: "gameResumed" });
    }

    this.state.describerId = entry.describerId;
    this.state.word = entry.word;
    this.state.turnStartedAt = entry.turnStartedAt;
    this.state.phase = entry.phase;
    this.state.winnerId = entry.winnerId;
    this.state.recent = entry.recent;
    this.toast(`Undid: ${entry.label}`);
  }

  /** Advances timers. Call about once a second. */
  tick(): void {
    const now = this.deps.now();
    const s = this.state;
    if (s.phase === "playing") {
      if (!s.word) {
        this.assignWord();
        return;
      }
      const describer = s.describerId ? this.player(s.describerId) : undefined;
      if (describer && !describer.connected && now - (describer.disconnectedAt ?? now) >= DESCRIBER_GRACE_MS) {
        const others = this.connectedPlayers().filter((p) => p.id !== describer.id);
        if (others.length > 0) {
          this.finishWord("abandoned", null, null);
          this.state.undoStack = [];
          this.seat(this.pick(others).id);
          this.toast(`${describer.name} dropped; ${this.name(s.describerId)} takes over`);
          return;
        }
      }
      if (s.turnStartedAt !== null && now - s.turnStartedAt >= s.settings.turnSeconds * 1000) {
        this.finishWord("timeout", null, null);
        s.phase = "resetting";
        s.resetEndsAt = now + s.settings.resetCountdownSeconds * 1000;
        s.undoStack = [];
        this.toast("Time's up! Highest scorer takes the seat…");
      }
    } else if (s.phase === "resetting" && s.resetEndsAt !== null && now >= s.resetEndsAt) {
      s.phase = "playing";
      s.resetEndsAt = null;
      this.seat(this.highestScorer().id);
    }
  }

  // --- Helpers ------------------------------------------------------------

  private requireWord(): void {
    if (this.state.phase !== "playing" || !this.state.word || !this.state.describerId) {
      throw new GameError("No word in play");
    }
  }

  private connectedPlayers(): PlayerState[] {
    return this.state.players.filter((p) => p.connected);
  }

  private pick<T>(items: T[]): T {
    return items[Math.floor(this.deps.random() * items.length)]!;
  }

  private highestScorer(): PlayerState {
    const pool = this.connectedPlayers().length > 0 ? this.connectedPlayers() : this.state.players;
    const top = Math.max(...pool.map((p) => p.score));
    return this.pick(pool.filter((p) => p.score === top));
  }

  /** Puts a player in the describer seat with a fresh word and timer. */
  private seat(playerId: string): void {
    this.state.describerId = playerId;
    this.state.turnStartedAt = this.deps.now();
    this.assignWord();
  }

  private assignWord(): void {
    const word = this.deps.drawWord();
    this.state.word = word;
    if (!word) this.effects.push({ type: "needWord" });
  }

  private finishWord(outcome: WordOutcome, playerId: string | null, source: ScoreSource | null): void {
    const word = this.state.word;
    if (!word) return;
    this.effects.push({ type: "wordFinished", wordId: word.id, outcome, playerId });
    this.state.recent = [{ word: word.word, outcome, playerId, source, at: this.deps.now() }, ...this.state.recent].slice(
      0,
      MAX_RECENT,
    );
    this.state.word = null;
  }

  private pushUndo(label: string): void {
    const s = this.state;
    s.undoStack.push({
      label,
      scores: Object.fromEntries(s.players.map((p) => [p.id, p.score])),
      describerId: s.describerId,
      word: s.word,
      turnStartedAt: s.turnStartedAt,
      phase: s.phase,
      winnerId: s.winnerId,
      recent: s.recent,
    });
    if (s.undoStack.length > MAX_UNDO) s.undoStack.shift();
  }

  private toast(text: string): void {
    this.effects.push({ type: "toast", text });
  }
}
