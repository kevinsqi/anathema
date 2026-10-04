import { useEffect, useRef, useState } from "react";
import {
  DIFFICULTIES,
  type Difficulty,
  type JoinResponse,
  type PublicPlayer,
  type PublicState,
  type SettingsPatch,
} from "../../../shared/protocol.ts";
import { startMic, type Mic } from "../mic.ts";
import { useLobby, useNow, type LobbyConnection } from "../useLobby.ts";

const OUTCOME_LABEL = {
  guessed: "guessed",
  fouled: "said it",
  skipped: "skipped",
  timeout: "timed out",
  abandoned: "dropped",
} as const;

const fmtScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function Lobby({ session, onLeave }: { session: JoinResponse; onLeave: () => void }) {
  const conn = useLobby(session);
  const { state, you, fatal } = conn;

  if (fatal) {
    return (
      <main className="home">
        <div className="card stack">
          <p className="error">{fatal}</p>
          <button onClick={onLeave}>Back home</button>
        </div>
      </main>
    );
  }
  if (!state || !you) return <main className="home muted">Connecting…</main>;

  const inGame = state.phase === "playing" || state.phase === "resetting";
  return (
    <div className="lobby">
      <Header conn={conn} state={state} />
      <div className="layout">
        <main className="stack">
          {inGame ? <GamePanel conn={conn} state={state} you={you} /> : <PregamePanel conn={conn} state={state} you={you} />}
        </main>
        <aside className="stack">
          <Scoreboard state={state} you={you} />
          <Captions conn={conn} state={state} />
          <RecentWords state={state} />
        </aside>
      </div>
      <Toasts conn={conn} />
    </div>
  );
}

function Header({ conn, state }: { conn: LobbyConnection; state: PublicState }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <header className="topbar">
      <a href="/" className="brand">
        Anathema
      </a>
      <span className="lobby-code">
        Lobby <strong>{state.code}</strong>
      </span>
      <button className="ghost small" onClick={() => void copy()}>
        {copied ? "Copied!" : "Copy invite link"}
      </button>
      <span className="spacer" />
      <MicToggle conn={conn} state={state} />
      {conn.status !== "open" && <span className="pill warn">Reconnecting…</span>}
    </header>
  );
}

function MicToggle({ conn, state }: { conn: LobbyConnection; state: PublicState }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const micRef = useRef<Mic | null>(null);
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;
  const { send, sendAudio } = conn;

  useEffect(() => () => micRef.current?.stop(), []);
  // Let the server know after reconnects.
  useEffect(() => {
    if (conn.status === "open") send({ t: "mic", on });
  }, [conn.status, on, send]);

  if (!state.sttAvailable || !state.settings.autoDetect) {
    return <span className="pill muted" title="Scoring is manual in this lobby">Manual scoring</span>;
  }

  const toggle = async () => {
    setError(null);
    if (on) {
      micRef.current?.stop();
      micRef.current = null;
      setOn(false);
      return;
    }
    try {
      micRef.current = await startMic((pcm) => {
        if (phaseRef.current === "playing") sendAudio(pcm);
      });
      setOn(true);
    } catch (err) {
      setError((err as Error).message || "Mic unavailable");
    }
  };

  return (
    <>
      {error && <span className="error small">{error}</span>}
      <button className={on ? "mic on" : "mic"} onClick={() => void toggle()} title="Auto-detects guesses and slips">
        {on ? "🎙 Mic on" : "🎙 Turn on mic"}
      </button>
    </>
  );
}

// --- Pregame / game over -------------------------------------------------

function PregamePanel({ conn, state, you }: { conn: LobbyConnection; state: PublicState; you: string }) {
  const isHost = state.hostId === you || !state.players.find((p) => p.id === state.hostId)?.connected;
  const winner = state.players.find((p) => p.id === state.winnerId);
  const connected = state.players.filter((p) => p.connected).length;
  const listReady = state.wordList.status === "ready" || state.wordList.remaining > 0;

  return (
    <>
      {state.phase === "finished" && (
        <section className="card winner">
          <div className="big">🏆 {winner?.name ?? "Someone"} wins!</div>
          {state.canUndo && (
            <button className="ghost small" onClick={() => conn.send({ t: "undo" })}>
              Undo last point
            </button>
          )}
        </section>
      )}
      <section className="card stack">
        <h2>Game settings</h2>
        <Settings conn={conn} state={state} editable={isHost} />
        <WordListLine state={state} />
        {isHost ? (
          <button
            className="primary"
            disabled={connected < 2 || !listReady}
            onClick={() => conn.send({ t: "start" })}
          >
            {connected < 2 ? "Waiting for players…" : state.phase === "finished" ? "Play again" : "Start game"}
          </button>
        ) : (
          <p className="muted">Waiting for the host to start…</p>
        )}
      </section>
      <section className="card stack small">
        <h3>How to play</h3>
        <ul className="rules">
          <li>The describer gets a secret word and describes it without saying it.</li>
          <li>First to say the word gets +1 and becomes the describer.</li>
          <li>
            Describer says the word, a close form, or any part of a phrase (“tent” for “camping tent”): −{fmtScore(state.settings.foulPenalty)}. Skipping: −
            {fmtScore(state.settings.skipPenalty)}.
          </li>
          <li>
            If nobody gets it within {Math.round(state.settings.turnSeconds / 60)} min, the highest scorer takes the seat.
          </li>
          <li>First to {state.settings.targetScore} wins.</li>
        </ul>
      </section>
    </>
  );
}

function Settings({ conn, state, editable }: { conn: LobbyConnection; state: PublicState; editable: boolean }) {
  const s = state.settings;
  const [theme, setTheme] = useState(s.theme);
  useEffect(() => setTheme(s.theme), [s.theme]);
  const patch = (p: SettingsPatch) => conn.send({ t: "settings", patch: p });

  return (
    <div className="settings">
      <label className="field">
        <span>Theme</span>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (theme.trim() !== s.theme) patch({ theme: theme.trim() });
          }}
        >
          <input
            value={theme}
            disabled={!editable || !state.wordGenAvailable}
            placeholder={state.wordGenAvailable ? "e.g. musical terms (blank = anything)" : "Needs OPENAI_API_KEY"}
            onChange={(e) => setTheme(e.target.value)}
            onBlur={() => theme.trim() !== s.theme && patch({ theme: theme.trim() })}
          />
          {editable && state.wordGenAvailable && theme.trim() !== s.theme && <button type="submit">Generate</button>}
        </form>
      </label>
      <label className="field">
        <span>Difficulty</span>
        <select
          value={s.difficulty}
          disabled={!editable || !state.wordGenAvailable}
          onChange={(e) => patch({ difficulty: e.target.value as Difficulty })}
        >
          {DIFFICULTIES.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Points to win</span>
        <input
          type="number"
          min={1}
          max={100}
          value={s.targetScore}
          disabled={!editable}
          onChange={(e) => e.target.valueAsNumber >= 1 && patch({ targetScore: e.target.valueAsNumber })}
        />
      </label>
      <label className="field">
        <span>Reset after (min)</span>
        <input
          type="number"
          min={1}
          max={30}
          value={s.turnSeconds / 60}
          disabled={!editable}
          onChange={(e) => e.target.valueAsNumber >= 1 && patch({ turnSeconds: Math.round(e.target.valueAsNumber * 60) })}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={s.autoDetect && state.sttAvailable}
          disabled={!editable || !state.sttAvailable}
          onChange={(e) => patch({ autoDetect: e.target.checked })}
        />
        <span>
          Auto-detect guesses from mics
          {!state.sttAvailable && <em className="muted"> (needs DEEPGRAM_API_KEY)</em>}
        </span>
      </label>
    </div>
  );
}

function WordListLine({ state }: { state: PublicState }) {
  const wl = state.wordList;
  return (
    <p className={wl.status === "error" ? "error small" : "muted small"}>
      {wl.status === "generating" && <span className="spinner" />}
      {wl.label}
      {wl.status !== "generating" && ` · ${wl.remaining} words left`}
      {wl.error && ` · ${wl.error}`}
    </p>
  );
}

// --- In game -------------------------------------------------------------

function GamePanel({ conn, state, you }: { conn: LobbyConnection; state: PublicState; you: string }) {
  const now = useNow() + conn.clockOffset;
  const describer = state.players.find((p) => p.id === state.describerId);
  const isDescriber = state.describerId === you;
  const isHost = state.hostId === you;

  if (state.phase === "resetting") {
    const secs = Math.max(0, Math.ceil(((state.resetEndsAt ?? now) - now) / 1000));
    return (
      <section className="card center stack">
        <div className="muted">Time’s up!</div>
        <div className="countdown">{secs}</div>
        <div>The highest scorer takes the describer seat…</div>
      </section>
    );
  }

  const remaining =
    state.turnStartedAt === null
      ? null
      : Math.max(0, state.turnStartedAt + state.settings.turnSeconds * 1000 - now);

  return (
    <>
      <section className={`card stack turn ${isDescriber ? "describer" : ""}`}>
        <div className="row between">
          <span className="muted">{isDescriber ? "You’re describing" : `${describer?.name ?? "Someone"} is describing`}</span>
          {remaining !== null && <Timer ms={remaining} />}
        </div>

        {isDescriber ? (
          <DescriberView conn={conn} state={state} you={you} />
        ) : (
          <>
            <div className="big-word muted">{state.waitingForWord ? "Waiting for words…" : "? ? ?"}</div>
            <div className="row">
              <button className="danger" onClick={() => conn.send({ t: "foul" })}>
                🚨 {describer?.name ?? "They"} said it!
              </button>
            </div>
          </>
        )}
      </section>

      <div className="row">
        {state.canUndo && (
          <button className="ghost" onClick={() => conn.send({ t: "undo" })}>
            ↩ Undo last
          </button>
        )}
        <span className="spacer" />
        {isHost && (
          <button className="ghost" onClick={() => confirm("End this game for everyone?") && conn.send({ t: "endGame" })}>
            End game
          </button>
        )}
      </div>
    </>
  );
}

function DescriberView({ conn, state, you }: { conn: LobbyConnection; state: PublicState; you: string }) {
  const { word } = conn;
  const guessers = state.players.filter((p) => p.id !== you);
  if (!word) return <div className="big-word muted">{state.waitingForWord ? "Generating more words…" : "…"}</div>;
  const offLimits = [...new Set([...word.components, ...word.variants.map((v) => v.toLowerCase())])];
  return (
    <>
      <div className="big-word">{word.word}</div>
      {offLimits.length > 0 && <div className="muted small center">Also off limits: {offLimits.join(", ")}</div>}
      <div className="stack">
        <span className="muted small">Someone got it? Tap who:</span>
        <div className="row wrap">
          {guessers.map((p) => (
            <button key={p.id} className="primary" onClick={() => conn.send({ t: "guessed", playerId: p.id })}>
              ✓ {p.name}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <button onClick={() => conn.send({ t: "skip" })}>Skip (−{fmtScore(state.settings.skipPenalty)})</button>
        <button className="danger" onClick={() => conn.send({ t: "foul" })}>
          I said it (−{fmtScore(state.settings.foulPenalty)})
        </button>
      </div>
    </>
  );
}

function Timer({ ms }: { ms: number }) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return <span className={`timer ${total <= 20 ? "low" : ""}`}>{`${m}:${s}`}</span>;
}

// --- Sidebar -------------------------------------------------------------

function Scoreboard({ state, you }: { state: PublicState; you: string }) {
  const players = [...state.players].sort((a, b) => b.score - a.score);
  return (
    <section className="card">
      <h3>
        Scores <span className="muted small">· first to {state.settings.targetScore}</span>
      </h3>
      <ul className="scores">
        {players.map((p) => (
          <PlayerRow key={p.id} p={p} state={state} you={you} />
        ))}
      </ul>
    </section>
  );
}

function PlayerRow({ p, state, you }: { p: PublicPlayer; state: PublicState; you: string }) {
  return (
    <li className={p.connected ? "" : "offline"}>
      <span className="name">
        {p.name}
        {p.id === you && <span className="muted"> (you)</span>}
        {p.id === state.hostId && <span className="tag">host</span>}
        {p.id === state.describerId && <span className="tag accent">describing</span>}
        {p.micOn && <span title="Mic on"> 🎙</span>}
        {!p.connected && <span className="muted small"> offline</span>}
      </span>
      <span className="score">{fmtScore(p.score)}</span>
    </li>
  );
}

function Captions({ conn, state }: { conn: LobbyConnection; state: PublicState }) {
  const now = useNow(1000);
  if (!state.sttAvailable || !state.settings.autoDetect) return null;
  const recent = state.players
    .map((p) => ({ p, c: conn.captions[p.id] }))
    .filter((x) => x.c && now - x.c.at < 8000);
  return (
    <section className="card">
      <h3>Heard</h3>
      {recent.length === 0 ? (
        <p className="muted small">Live transcripts show up here while people talk.</p>
      ) : (
        <ul className="captions">
          {recent.map(({ p, c }) => (
            <li key={p.id} className={c!.matched ? "matched" : c!.final ? "" : "interim"}>
              <strong>{p.name}:</strong> {c!.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentWords({ state }: { state: PublicState }) {
  if (state.recent.length === 0) return null;
  const name = (id: string | null) => state.players.find((p) => p.id === id)?.name;
  return (
    <section className="card">
      <h3>Recent words</h3>
      <ul className="recent">
        {state.recent.map((r) => (
          <li key={`${r.word}-${r.at}`}>
            <strong>{r.word}</strong>{" "}
            <span className="muted small">
              {r.playerId ? `${name(r.playerId)} ` : ""}
              {OUTCOME_LABEL[r.outcome]}
              {r.source === "auto" && " · auto"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Toasts({ conn }: { conn: LobbyConnection }) {
  return (
    <div className="toasts">
      {conn.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
