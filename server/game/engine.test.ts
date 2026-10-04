import { beforeEach, describe, expect, it } from "vitest";
import { DESCRIBER_GRACE_MS, Game, GameError, initialState, type WordEntry } from "./engine.ts";

function setup(playerIds = ["a", "b", "c"]) {
  let now = 1_000_000;
  let nextWordId = 1;
  const pool: WordEntry[] = [];
  const clock = {
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
  };
  const game = new Game(initialState(playerIds[0]!), {
    now: () => now,
    random: () => 0, // always pick the first candidate
    drawWord: () => pool.shift() ?? null,
  });
  const addWords = (n: number) => {
    for (let i = 0; i < n; i++) {
      const id = nextWordId++;
      pool.push({ id, word: `word${id}`, variants: [] });
    }
  };
  addWords(50);
  for (const id of playerIds) {
    game.addPlayer(id, id.toUpperCase());
    game.setConnected(id, true);
  }
  return { game, clock, addWords, pool };
}

const scores = (game: Game) => Object.fromEntries(game.state.players.map((p) => [p.id, p.score]));

describe("Game", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("needs two connected players to start", () => {
    const solo = setup(["a"]);
    expect(() => solo.game.start()).toThrow(GameError);
  });

  it("starts with a random describer and a word", () => {
    t.game.start();
    expect(t.game.state.phase).toBe("playing");
    expect(t.game.state.describerId).toBe("a");
    expect(t.game.state.word?.word).toBe("word1");
  });

  it("gives the guesser a point and the describer seat", () => {
    t.game.start();
    t.game.correctGuess("b", "manual");
    expect(scores(t.game)).toEqual({ a: 0, b: 1, c: 0 });
    expect(t.game.state.describerId).toBe("b");
    expect(t.game.state.word?.word).toBe("word2");
    expect(t.game.state.recent[0]).toMatchObject({ word: "word1", outcome: "guessed", playerId: "b" });
  });

  it("rejects the describer guessing their own word", () => {
    t.game.start();
    expect(() => t.game.correctGuess("a", "auto")).toThrow(GameError);
  });

  it("fouls cost a point and keep the describer", () => {
    t.game.start();
    t.game.foul("auto");
    expect(scores(t.game).a).toBe(-1);
    expect(t.game.state.describerId).toBe("a");
    expect(t.game.state.word?.word).toBe("word2");
  });

  it("skips cost half a point", () => {
    t.game.start();
    t.game.skip();
    t.game.skip();
    expect(scores(t.game).a).toBe(-1);
    expect(t.game.state.word?.word).toBe("word3");
  });

  it("ends when someone reaches the target score", () => {
    t.game.updateSettings({ targetScore: 2 });
    t.game.start();
    t.game.correctGuess("b", "manual"); // b describes
    t.game.correctGuess("a", "manual"); // a describes
    t.game.correctGuess("b", "manual");
    expect(t.game.state.phase).toBe("finished");
    expect(t.game.state.winnerId).toBe("b");
    expect(t.game.state.word).toBeNull();
  });

  it("undo restores scores, describer and word", () => {
    t.game.start();
    t.game.correctGuess("b", "auto");
    t.game.drainEffects();
    t.game.undo();
    expect(scores(t.game)).toEqual({ a: 0, b: 0, c: 0 });
    expect(t.game.state.describerId).toBe("a");
    expect(t.game.state.word?.word).toBe("word1");
    expect(t.game.state.recent).toEqual([]);
    const effects = t.game.drainEffects();
    expect(effects).toContainEqual({ type: "wordReleased", wordId: 2 });
    expect(effects).toContainEqual({ type: "wordRestored", wordId: 1 });
    expect(() => t.game.undo()).toThrow(GameError);
  });

  it("undo can reverse a winning guess", () => {
    t.game.updateSettings({ targetScore: 1 });
    t.game.start();
    t.game.correctGuess("c", "auto");
    expect(t.game.state.phase).toBe("finished");
    t.game.undo();
    expect(t.game.state.phase).toBe("playing");
    expect(t.game.state.winnerId).toBeNull();
  });

  it("resets to the highest scorer after the seat timer runs out", () => {
    t.game.start();
    t.game.correctGuess("c", "manual"); // c: 1, c describes
    t.game.correctGuess("b", "manual"); // b: 1, b describes
    t.game.correctGuess("c", "manual"); // c: 2, c describes
    t.game.correctGuess("a", "manual"); // a: 1, a describes
    t.clock.advance(t.game.state.settings.turnSeconds * 1000 - 1);
    t.game.tick();
    expect(t.game.state.phase).toBe("playing");

    t.clock.advance(1);
    t.game.tick();
    expect(t.game.state.phase).toBe("resetting");
    expect(t.game.state.word).toBeNull();
    expect(t.game.state.recent[0]?.outcome).toBe("timeout");

    t.clock.advance(t.game.state.settings.resetCountdownSeconds * 1000);
    t.game.tick();
    expect(t.game.state.phase).toBe("playing");
    expect(t.game.state.describerId).toBe("c");
    expect(t.game.state.turnStartedAt).toBe(t.clock.now);
  });

  it("skips and fouls do not restart the seat timer", () => {
    t.game.start();
    const started = t.game.state.turnStartedAt;
    t.clock.advance(1000);
    t.game.skip();
    t.game.foul("manual");
    expect(t.game.state.turnStartedAt).toBe(started);
  });

  it("passes the seat when the describer stays disconnected", () => {
    t.game.start();
    t.game.setConnected("a", false);
    t.clock.advance(DESCRIBER_GRACE_MS - 1);
    t.game.tick();
    expect(t.game.state.describerId).toBe("a");
    t.clock.advance(1);
    t.game.tick();
    expect(t.game.state.describerId).toBe("b");
    expect(t.game.state.recent[0]?.outcome).toBe("abandoned");
  });

  it("waits for words when the pool is empty, then resumes", () => {
    t.pool.length = 0;
    t.game.start();
    expect(t.game.state.word).toBeNull();
    expect(t.game.drainEffects()).toContainEqual({ type: "needWord" });
    t.addWords(1);
    t.game.tick();
    expect(t.game.state.word).not.toBeNull();
  });

  it("locks the word list while a game runs", () => {
    t.game.start();
    expect(() => t.game.updateSettings({ theme: "birds" })).toThrow(GameError);
    t.game.updateSettings({ autoDetect: false });
    expect(t.game.state.settings.autoDetect).toBe(false);
  });
});
