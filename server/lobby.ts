// Live lobbies: wires the game engine to sockets, persistence, word lists and STT.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  ClientMessage,
  DEFAULT_SETTINGS,
  type JoinResponse,
  type PublicState,
  type ServerMessage,
  type WordListStatus,
} from "../shared/protocol.ts";
import { config } from "./config.ts";
import type { Repo, WordListRow } from "./db.ts";
import { Game, GameError, initialState, type EngineState, type WordEntry } from "./game/engine.ts";
import { DeepgramStream, sttAvailable, type Transcript } from "./stt/deepgram.ts";
import { wordGenAvailable } from "./words/generate.ts";
import { buildForms, transcriptMatches, type WordForms } from "./words/matcher.ts";
import { listLabel, type WordLists } from "./words/service.ts";

/** Generate more words when a lobby's pool drops to this many. */
const LOW_WATER = 10;
const STT_IDLE_MS = 5_000;
/** After a stream fails, wait this long before opening another for that player. */
const STT_RETRY_MS = 10_000;

interface Snapshot {
  engine: EngineState;
  gameId: number | null;
  lastGameId: number | null;
}

interface Deps {
  repo: Repo;
  wordLists: WordLists;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export class LobbyRoom {
  readonly game: Game;
  private gameId: number | null;
  private lastGameId: number | null;
  private wordList: WordListRow | null = null;
  private wordListStatus: WordListStatus = { status: "generating", label: "Loading words…", remaining: 0 };
  private pool: (WordEntry & { norm: string })[] = [];
  private toppingUp = false;
  private sockets = new Map<string, Set<WebSocket>>();
  private stt = new Map<string, { stream: DeepgramStream; wordId: number }>();
  private sttRetryAt = new Map<string, number>();
  private forms: { wordId: number; forms: WordForms } | null = null;
  private timer: NodeJS.Timeout;
  private lastSaved = "";
  private lastBroadcast = "";
  emptySince: number | null = Date.now();

  constructor(
    private deps: Deps,
    readonly lobbyId: number,
    readonly code: string,
    snapshot: Snapshot,
    wordListId: number | null,
  ) {
    this.gameId = snapshot.gameId;
    this.lastGameId = snapshot.lastGameId;
    this.game = new Game(snapshot.engine, {
      now: Date.now,
      random: Math.random,
      drawWord: () => this.drawWord(),
    });
    // Nobody is connected right after a load.
    for (const p of this.game.state.players) this.game.setConnected(p.id, false);
    this.game.drainEffects();
    this.lastSaved = this.snapshotJson();

    const existing = wordListId ? deps.repo.wordList(wordListId) : undefined;
    if (existing) this.useWordList(existing);
    else void this.prepareWordList();

    this.timer = setInterval(() => this.tick(), 1000);
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const playerId of [...this.stt.keys()]) this.closeStt(playerId);
  }

  // --- Connections --------------------------------------------------------

  connect(playerId: string, ws: WebSocket): void {
    let set = this.sockets.get(playerId);
    if (!set) this.sockets.set(playerId, (set = new Set()));
    set.add(ws);
    this.emptySince = null;
    this.game.setConnected(playerId, true);
    this.flush();
    this.sendState(playerId, ws);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleAudio(playerId, data as Buffer);
        return;
      }
      let parsed: ClientMessage;
      try {
        parsed = ClientMessage.parse(JSON.parse(data.toString()));
      } catch {
        this.send(ws, { t: "error", message: "Bad message" });
        return;
      }
      this.handleMessage(playerId, ws, parsed);
    });
    ws.on("close", () => this.disconnect(playerId, ws));
  }

  private disconnect(playerId: string, ws: WebSocket): void {
    const set = this.sockets.get(playerId);
    set?.delete(ws);
    if (set && set.size > 0) return;
    this.sockets.delete(playerId);
    this.closeStt(playerId);
    this.game.setConnected(playerId, false);
    if (this.sockets.size === 0) this.emptySince = Date.now();
    this.flush();
  }

  addPlayer(name: string): JoinResponse {
    const { repo } = this.deps;
    if (repo.playerNameTaken(this.lobbyId, name)) throw new HttpError(409, "That name is taken in this lobby");
    const playerId = randomUUID();
    const token = randomBytes(24).toString("base64url");
    repo.createPlayer({ id: playerId, lobby_id: this.lobbyId, name, token, joined_at: Date.now() });
    this.game.addPlayer(playerId, name);
    this.flush();
    return { code: this.code, playerId, token };
  }

  // --- Messages -----------------------------------------------------------

  private handleMessage(playerId: string, ws: WebSocket, msg: ClientMessage): void {
    const game = this.game;
    const s = game.state;
    try {
      switch (msg.t) {
        case "start":
          this.requireHost(playerId);
          if (this.wordListStatus.status === "generating" && this.pool.length === 0) {
            throw new GameError("Words are still being generated");
          }
          if (!this.wordList) throw new GameError("No word list yet");
          if (this.pool.length === 0 && this.wordListStatus.status === "error") {
            throw new GameError(this.wordListStatus.error ?? "No words left");
          }
          game.start();
          break;
        case "settings": {
          this.requireHost(playerId);
          const before = `${s.settings.theme}|${s.settings.difficulty}`;
          game.updateSettings(msg.patch);
          if (`${s.settings.theme}|${s.settings.difficulty}` !== before) void this.prepareWordList();
          break;
        }
        case "guessed":
          if (playerId !== s.describerId) throw new GameError("Only the describer can award a guess");
          game.correctGuess(msg.playerId, "manual");
          break;
        case "foul":
          game.foul("manual");
          break;
        case "skip":
          if (playerId !== s.describerId) throw new GameError("Only the describer can skip");
          game.skip();
          break;
        case "undo":
          game.undo();
          break;
        case "endGame":
          this.requireHost(playerId);
          game.endGame();
          break;
        case "mic":
          game.setMic(playerId, msg.on);
          if (!msg.on) this.closeStt(playerId);
          break;
      }
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      this.send(ws, { t: "error", message: err.message });
    }
    this.flush();
  }

  private requireHost(playerId: string): void {
    if (!this.game.isHostLike(playerId)) throw new GameError("Only the host can do that");
  }

  // --- Speech-to-text -----------------------------------------------------

  private handleAudio(playerId: string, chunk: Buffer): void {
    const s = this.game.state;
    const word = s.word;
    if (!sttAvailable() || !s.settings.autoDetect || s.phase !== "playing" || !word) {
      this.closeStt(playerId);
      return;
    }
    let session = this.stt.get(playerId);
    if (session && session.wordId !== word.id) {
      this.closeStt(playerId);
      session = undefined;
    }
    if (!session) {
      if ((this.sttRetryAt.get(playerId) ?? 0) > Date.now()) return;
      const wordId = word.id;
      const stream = new DeepgramStream(
        [word.word, ...word.variants].slice(0, 20),
        (t) => this.onTranscript(playerId, wordId, t),
        (err) => {
          console.error(`[stt] ${this.code}/${playerId}:`, err.message);
          this.closeStt(playerId);
          this.sttRetryAt.set(playerId, Date.now() + STT_RETRY_MS);
          this.sendTo(playerId, { t: "error", message: "Speech recognition failed; retrying shortly" });
        },
      );
      session = { stream, wordId };
      this.stt.set(playerId, session);
    }
    session.stream.send(chunk);
  }

  private onTranscript(playerId: string, wordId: number, t: Transcript): void {
    const s = this.game.state;
    if (s.phase !== "playing" || s.word?.id !== wordId) return;
    if (this.forms?.wordId !== wordId) {
      this.forms = { wordId, forms: buildForms(s.word.word, s.word.variants) };
    }
    const matched = transcriptMatches(t, this.forms.forms, config.sttMinConfidence);
    this.broadcast({ t: "caption", playerId, text: t.text, final: t.final, matched });
    if (!matched) return;
    try {
      if (playerId === s.describerId) this.game.foul("auto");
      else this.game.correctGuess(playerId, "auto");
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
    }
    this.flush();
  }

  private closeStt(playerId: string): void {
    this.stt.get(playerId)?.stream.close();
    this.stt.delete(playerId);
  }

  /** Drops streams for stale words, idle mics or a paused game. */
  private syncStt(): void {
    const s = this.game.state;
    const now = Date.now();
    for (const [playerId, session] of this.stt) {
      const stale =
        s.phase !== "playing" ||
        !s.settings.autoDetect ||
        session.wordId !== s.word?.id ||
        now - session.stream.lastAudioAt > STT_IDLE_MS;
      if (stale) this.closeStt(playerId);
    }
  }

  // --- Words --------------------------------------------------------------

  private async prepareWordList(): Promise<void> {
    const { theme, difficulty } = this.game.state.settings;
    this.wordListStatus = {
      status: "generating",
      label: theme ? `Generating “${theme}” (${difficulty})…` : "Generating words…",
      remaining: 0,
    };
    this.flush();
    try {
      const list = await this.deps.wordLists.ensureList(theme, difficulty);
      const current = this.game.state.settings;
      if (current.theme !== theme || current.difficulty !== difficulty) return; // superseded
      this.useWordList(list);
    } catch (err) {
      console.error(`[words] ${this.code}:`, err);
      this.wordListStatus = { status: "error", label: "Word list failed", remaining: 0, error: (err as Error).message };
    }
    this.flush();
  }

  private useWordList(list: WordListRow): void {
    this.wordList = list;
    this.refreshPool();
    this.wordListStatus = { status: "ready", label: listLabel(list), remaining: this.pool.length };
    if (this.pool.length <= LOW_WATER) void this.topUp();
  }

  private refreshPool(): void {
    if (!this.wordList) return;
    const used = this.deps.repo.usedNorms(this.lobbyId);
    this.pool = shuffle(this.deps.repo.listWords(this.wordList.id).filter((w) => !used.has(w.norm)));
    this.wordListStatus.remaining = this.pool.length;
  }

  private drawWord(): WordEntry | null {
    const w = this.pool.pop();
    if (this.pool.length <= LOW_WATER) void this.topUp();
    this.wordListStatus.remaining = this.pool.length;
    if (!w) return null;
    this.deps.repo.markWordUsed(this.lobbyId, this.ensureGameId(), w.id, w.norm);
    return { id: w.id, word: w.word, variants: w.variants };
  }

  private async topUp(): Promise<void> {
    const list = this.wordList;
    if (!list || this.toppingUp) return;
    if (list.source === "builtin" || !wordGenAvailable()) {
      if (this.pool.length === 0) {
        this.wordListStatus = { ...this.wordListStatus, status: "error", error: "Out of words" };
      }
      return;
    }
    this.toppingUp = true;
    try {
      const used = [...this.deps.repo.usedNorms(this.lobbyId)];
      await this.deps.wordLists.topUp(list, used);
      if (this.wordList?.id === list.id) {
        this.refreshPool();
        this.wordListStatus = { status: "ready", label: listLabel(list), remaining: this.pool.length };
        this.game.tick(); // hands a word to a describer who was waiting
      }
    } catch (err) {
      console.error(`[words] top-up ${this.code}:`, err);
      if (this.pool.length === 0) {
        this.wordListStatus = { ...this.wordListStatus, status: "error", error: "Couldn't generate more words" };
      }
    } finally {
      this.toppingUp = false;
    }
    this.flush();
  }

  private ensureGameId(): number {
    this.gameId ??= this.deps.repo.createGame(this.lobbyId, this.wordList?.id ?? null);
    return this.gameId;
  }

  // --- State sync ---------------------------------------------------------

  private tick(): void {
    this.game.tick();
    this.flush();
  }

  /** Applies engine effects, persists, and pushes state to clients. */
  private flush(): void {
    const { repo } = this.deps;
    let releasedWord = false;
    for (const e of this.game.drainEffects()) {
      switch (e.type) {
        case "gameStarted":
          this.ensureGameId();
          break;
        case "gameEnded":
          if (this.gameId) repo.endGame(this.gameId, e.winnerId);
          this.lastGameId = this.gameId;
          this.gameId = null;
          break;
        case "gameResumed":
          this.gameId = this.lastGameId;
          if (this.gameId) repo.resumeGame(this.gameId);
          break;
        case "score": {
          const gameId = this.gameId ?? this.lastGameId;
          if (gameId) repo.addScoreEvent(gameId, e);
          break;
        }
        case "wordFinished":
          repo.setWordOutcome(this.lobbyId, e.wordId, e.outcome, e.playerId);
          break;
        case "wordRestored":
          repo.setWordOutcome(this.lobbyId, e.wordId, null, null);
          break;
        case "wordReleased":
          repo.releaseWord(this.lobbyId, e.wordId);
          releasedWord = true;
          break;
        case "needWord":
          void this.topUp();
          break;
        case "toast":
          this.broadcast({ t: "toast", text: e.text });
          break;
      }
    }
    if (releasedWord) this.refreshPool();

    const snapshot = this.snapshotJson();
    if (snapshot !== this.lastSaved) {
      repo.saveLobby(this.lobbyId, snapshot, this.wordList?.id ?? null);
      this.lastSaved = snapshot;
    }
    this.syncStt();

    const publicJson = JSON.stringify(this.publicState()) + (this.game.state.word?.id ?? "");
    if (publicJson !== this.lastBroadcast) {
      this.lastBroadcast = publicJson;
      for (const [playerId, set] of this.sockets) for (const ws of set) this.sendState(playerId, ws);
    }
  }

  private snapshotJson(): string {
    const snap: Snapshot = { engine: this.game.state, gameId: this.gameId, lastGameId: this.lastGameId };
    return JSON.stringify(snap);
  }

  publicState(): PublicState {
    const s = this.game.state;
    return {
      code: this.code,
      phase: s.phase,
      hostId: s.hostId,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        micOn: p.micOn,
      })),
      describerId: s.describerId,
      waitingForWord: s.phase === "playing" && !s.word,
      turnStartedAt: s.turnStartedAt,
      resetEndsAt: s.resetEndsAt,
      winnerId: s.winnerId,
      settings: s.settings,
      wordList: this.wordListStatus,
      recent: s.recent,
      canUndo: s.undoStack.length > 0,
      sttAvailable: sttAvailable(),
      wordGenAvailable: wordGenAvailable(),
    };
  }

  private sendState(playerId: string, ws: WebSocket): void {
    const s = this.game.state;
    const word = playerId === s.describerId && s.word ? { word: s.word.word, variants: s.word.variants } : null;
    this.send(ws, { t: "state", state: this.publicState(), you: playerId, word, serverNow: Date.now() });
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const set of this.sockets.values()) for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  private sendTo(playerId: string, msg: ServerMessage): void {
    for (const ws of this.sockets.get(playerId) ?? []) this.send(ws, msg);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

/** Owns the in-memory rooms, loading them from SQLite on demand. */
export class LobbyManager {
  private rooms = new Map<string, LobbyRoom>();
  private sweeper: NodeJS.Timeout;

  constructor(private deps: Deps) {
    // Unload rooms nobody has been in for a while; they reload from the DB on demand.
    this.sweeper = setInterval(() => {
      for (const [code, room] of this.rooms) {
        if (room.emptySince && Date.now() - room.emptySince > 30 * 60_000) {
          room.dispose();
          this.rooms.delete(code);
        }
      }
    }, 60_000);
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) room.dispose();
  }

  create(name: string): JoinResponse {
    const { repo } = this.deps;
    let code: string;
    do code = String(randomInt(10000, 100000));
    while (repo.lobbyCodeExists(code));

    const hostId = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const engine = initialState(hostId, DEFAULT_SETTINGS);
    engine.players.push({ id: hostId, name, score: 0, connected: false, disconnectedAt: null, micOn: false });
    const snapshot: Snapshot = { engine, gameId: null, lastGameId: null };

    const lobbyId = repo.transaction(() => {
      const id = repo.createLobby(code, hostId, JSON.stringify(snapshot));
      repo.createPlayer({ id: hostId, lobby_id: id, name, token, joined_at: Date.now() });
      return id;
    });
    this.rooms.set(code, new LobbyRoom(this.deps, lobbyId, code, snapshot, null));
    return { code, playerId: hostId, token };
  }

  join(code: string, name: string, token: string | undefined): JoinResponse {
    const room = this.get(code);
    if (!room) throw new HttpError(404, "No lobby with that code");
    if (token) {
      const existing = this.deps.repo.playerByToken(room.lobbyId, token);
      if (existing) return { code, playerId: existing.id, token };
    }
    return room.addPlayer(name);
  }

  get(code: string): LobbyRoom | undefined {
    const loaded = this.rooms.get(code);
    if (loaded) return loaded;
    const row = this.deps.repo.lobbyByCode(code);
    if (!row) return undefined;
    const room = new LobbyRoom(this.deps, row.id, code, JSON.parse(row.state_json) as Snapshot, row.word_list_id);
    this.rooms.set(code, room);
    return room;
  }

  authenticate(code: string, token: string): { room: LobbyRoom; playerId: string } | undefined {
    const room = this.get(code);
    const player = room && this.deps.repo.playerByToken(room.lobbyId, token);
    return room && player ? { room, playerId: player.id } : undefined;
  }
}
