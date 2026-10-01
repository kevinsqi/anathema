// SQLite persistence via Node's built-in node:sqlite.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Difficulty, ScoreSource, WordOutcome } from "../shared/protocol.ts";
import type { ScoreKind, WordEntry } from "./game/engine.ts";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE word_lists (
    id INTEGER PRIMARY KEY,
    theme TEXT NOT NULL,
    theme_key TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    source TEXT NOT NULL,          -- 'builtin' | 'openai'
    model TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX word_lists_lookup ON word_lists (theme_key, difficulty);

  CREATE TABLE words (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES word_lists (id),
    word TEXT NOT NULL,
    norm TEXT NOT NULL,
    variants_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE (list_id, norm)
  );

  CREATE TABLE lobbies (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    host_player_id TEXT NOT NULL,
    word_list_id INTEGER REFERENCES word_lists (id),
    state_json TEXT NOT NULL,      -- snapshot of the live game engine state
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE players (
    id TEXT PRIMARY KEY,
    lobby_id INTEGER NOT NULL REFERENCES lobbies (id),
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    UNIQUE (lobby_id, name COLLATE NOCASE)
  );

  CREATE TABLE games (
    id INTEGER PRIMARY KEY,
    lobby_id INTEGER NOT NULL REFERENCES lobbies (id),
    word_list_id INTEGER REFERENCES word_lists (id),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    winner_player_id TEXT
  );

  CREATE TABLE score_events (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games (id),
    player_id TEXT NOT NULL,
    kind TEXT NOT NULL,            -- 'guess' | 'foul' | 'skip' | 'undo'
    delta REAL NOT NULL,
    word TEXT,
    source TEXT NOT NULL,          -- 'auto' | 'manual'
    created_at INTEGER NOT NULL
  );

  -- Every word a lobby has drawn, across all of its games, so none repeat.
  CREATE TABLE lobby_used_words (
    lobby_id INTEGER NOT NULL REFERENCES lobbies (id),
    norm TEXT NOT NULL,
    word_id INTEGER NOT NULL REFERENCES words (id),
    game_id INTEGER REFERENCES games (id),
    outcome TEXT,
    player_id TEXT,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (lobby_id, norm)
  );
  `,
];

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  }
  return db;
}

export interface WordListRow {
  id: number;
  theme: string;
  difficulty: Difficulty;
  source: string;
}

export interface LobbyRow {
  id: number;
  code: string;
  host_player_id: string;
  word_list_id: number | null;
  state_json: string;
}

export interface PlayerRow {
  id: string;
  lobby_id: number;
  name: string;
  token: string;
  joined_at: number;
}

interface WordRow {
  id: number;
  word: string;
  norm: string;
  variants_json: string;
}

export class Repo {
  constructor(private db: DatabaseSync) {}

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- Word lists ---------------------------------------------------------

  findWordList(themeKey: string, difficulty: Difficulty): WordListRow | undefined {
    return this.db
      .prepare(
        "SELECT id, theme, difficulty, source FROM word_lists WHERE theme_key = ? AND difficulty = ? ORDER BY id DESC LIMIT 1",
      )
      .get(themeKey, difficulty) as WordListRow | undefined;
  }

  wordList(id: number): WordListRow | undefined {
    return this.db.prepare("SELECT id, theme, difficulty, source FROM word_lists WHERE id = ?").get(id) as
      | WordListRow
      | undefined;
  }

  createWordList(theme: string, themeKey: string, difficulty: Difficulty, source: string, model: string | null): number {
    const res = this.db
      .prepare("INSERT INTO word_lists (theme, theme_key, difficulty, source, model, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(theme, themeKey, difficulty, source, model, Date.now());
    return Number(res.lastInsertRowid);
  }

  /** Inserts words, skipping ones already in the list. Returns how many were new. */
  addWords(listId: number, words: { word: string; norm: string; variants: string[] }[]): number {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO words (list_id, word, norm, variants_json) VALUES (?, ?, ?, ?)",
    );
    return this.transaction(() => {
      let added = 0;
      for (const w of words) added += Number(stmt.run(listId, w.word, w.norm, JSON.stringify(w.variants)).changes);
      return added;
    });
  }

  listWords(listId: number): (WordEntry & { norm: string })[] {
    const rows = this.db
      .prepare("SELECT id, word, norm, variants_json FROM words WHERE list_id = ? ORDER BY id")
      .all(listId) as unknown as WordRow[];
    return rows.map((r) => ({ id: r.id, word: r.word, norm: r.norm, variants: JSON.parse(r.variants_json) as string[] }));
  }

  // --- Lobbies & players --------------------------------------------------

  lobbyCodeExists(code: string): boolean {
    return this.db.prepare("SELECT 1 FROM lobbies WHERE code = ?").get(code) !== undefined;
  }

  createLobby(code: string, hostPlayerId: string, stateJson: string): number {
    const now = Date.now();
    const res = this.db
      .prepare("INSERT INTO lobbies (code, host_player_id, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(code, hostPlayerId, stateJson, now, now);
    return Number(res.lastInsertRowid);
  }

  lobbyByCode(code: string): LobbyRow | undefined {
    return this.db
      .prepare("SELECT id, code, host_player_id, word_list_id, state_json FROM lobbies WHERE code = ?")
      .get(code) as LobbyRow | undefined;
  }

  saveLobby(id: number, stateJson: string, wordListId: number | null): void {
    this.db
      .prepare("UPDATE lobbies SET state_json = ?, word_list_id = ?, updated_at = ? WHERE id = ?")
      .run(stateJson, wordListId, Date.now(), id);
  }

  createPlayer(row: PlayerRow): void {
    this.db
      .prepare("INSERT INTO players (id, lobby_id, name, token, joined_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.lobby_id, row.name, row.token, row.joined_at);
  }

  playerByToken(lobbyId: number, token: string): PlayerRow | undefined {
    return this.db.prepare("SELECT * FROM players WHERE lobby_id = ? AND token = ?").get(lobbyId, token) as
      | PlayerRow
      | undefined;
  }

  playerNameTaken(lobbyId: number, name: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM players WHERE lobby_id = ? AND name = ? COLLATE NOCASE").get(lobbyId, name) !==
      undefined
    );
  }

  // --- Games & scoring ----------------------------------------------------

  createGame(lobbyId: number, wordListId: number | null): number {
    const res = this.db
      .prepare("INSERT INTO games (lobby_id, word_list_id, started_at) VALUES (?, ?, ?)")
      .run(lobbyId, wordListId, Date.now());
    return Number(res.lastInsertRowid);
  }

  endGame(gameId: number, winnerId: string | null): void {
    this.db.prepare("UPDATE games SET ended_at = ?, winner_player_id = ? WHERE id = ?").run(Date.now(), winnerId, gameId);
  }

  resumeGame(gameId: number): void {
    this.db.prepare("UPDATE games SET ended_at = NULL, winner_player_id = NULL WHERE id = ?").run(gameId);
  }

  addScoreEvent(
    gameId: number,
    e: { playerId: string; kind: ScoreKind; delta: number; word: string | null; source: ScoreSource },
  ): void {
    this.db
      .prepare(
        "INSERT INTO score_events (game_id, player_id, kind, delta, word, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(gameId, e.playerId, e.kind, e.delta, e.word, e.source, Date.now());
  }

  // --- Used words ---------------------------------------------------------

  usedNorms(lobbyId: number): Set<string> {
    const rows = this.db.prepare("SELECT norm FROM lobby_used_words WHERE lobby_id = ?").all(lobbyId) as {
      norm: string;
    }[];
    return new Set(rows.map((r) => r.norm));
  }

  markWordUsed(lobbyId: number, gameId: number | null, wordId: number, norm: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO lobby_used_words (lobby_id, norm, word_id, game_id, used_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(lobbyId, norm, wordId, gameId, Date.now());
  }

  setWordOutcome(lobbyId: number, wordId: number, outcome: WordOutcome | null, playerId: string | null): void {
    this.db
      .prepare("UPDATE lobby_used_words SET outcome = ?, player_id = ? WHERE lobby_id = ? AND word_id = ?")
      .run(outcome, playerId, lobbyId, wordId);
  }

  releaseWord(lobbyId: number, wordId: number): void {
    this.db.prepare("DELETE FROM lobby_used_words WHERE lobby_id = ? AND word_id = ?").run(lobbyId, wordId);
  }
}
