import { useEffect, useRef, useState } from "react";
import type { ServerMessage } from "../../../shared/protocol.ts";
import { level, startMic, type Mic } from "../mic.ts";

interface Line {
  text: string;
  final: boolean;
  matched: boolean;
  ms: number;
}

/** Talk into the mic and see what the recognizer hears, plus whether it matches a word. */
export function MicTest() {
  const [word, setWord] = useState("flames");
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [meter, setMeter] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<() => void>(() => {});
  const startedAt = useRef(0);

  useEffect(() => () => stopRef.current(), []);

  const start = async () => {
    setError(null);
    setLines([]);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/mictest?${new URLSearchParams({ word })}`);
    ws.binaryType = "arraybuffer";
    let mic: Mic | null = null;
    startedAt.current = performance.now();

    ws.onmessage = (e: MessageEvent<string>) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      if (msg.t === "error") setError(msg.message);
      if (msg.t !== "caption") return;
      const line = { text: msg.text, final: msg.final, matched: msg.matched, ms: performance.now() - startedAt.current };
      // Interim results replace the previous interim line.
      setLines((prev) => (prev[0] && !prev[0].final ? [line, ...prev.slice(1)] : [line, ...prev]).slice(0, 30));
    };
    ws.onclose = () => stop();

    const stop = () => {
      mic?.stop();
      mic = null;
      ws.close();
      setRunning(false);
      setMeter(0);
    };
    stopRef.current = stop;

    try {
      mic = await startMic((pcm) => {
        setMeter(level(pcm));
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
      });
      // The server may have hung up (e.g. no API key) while we waited for mic permission.
      if (ws.readyState >= WebSocket.CLOSING) return stop();
      setRunning(true);
    } catch (err) {
      setError((err as Error).message || "Mic unavailable");
      stop();
    }
  };

  return (
    <main className="home">
      <h1>Mic test</h1>
      <div className="card stack">
        <label className="field">
          <span>Target word (biases the recognizer, like in a real game)</span>
          <input value={word} disabled={running} onChange={(e) => setWord(e.target.value)} />
        </label>
        <div className="row">
          {running ? (
            <button onClick={() => stopRef.current()}>Stop</button>
          ) : (
            <button className="primary" onClick={() => void start()}>
              Start listening
            </button>
          )}
          <div className="meter">
            <div style={{ width: `${Math.round(meter * 100)}%` }} />
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <ul className="captions">
          {lines.map((l, i) => (
            <li key={i} className={l.matched ? "matched" : l.final ? "" : "interim"}>
              {l.matched && "✅ "}
              {l.text} <span className="muted small">{(l.ms / 1000).toFixed(1)}s</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="muted small">
        <a href="/">Back home</a>
      </p>
    </main>
  );
}
