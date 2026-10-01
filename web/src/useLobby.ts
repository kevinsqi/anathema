// Keeps a WebSocket to the lobby open and exposes its latest state.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, JoinResponse, PublicState, SecretWord, ServerMessage } from "../../shared/protocol.ts";

export interface Caption {
  text: string;
  final: boolean;
  matched: boolean;
  at: number;
}

export interface Toast {
  id: number;
  text: string;
  error?: boolean;
}

export interface LobbyConnection {
  state: PublicState | null;
  you: string | null;
  word: SecretWord | null;
  captions: Record<string, Caption>;
  toasts: Toast[];
  status: "connecting" | "open" | "closed";
  fatal: string | null;
  /** Server time minus local time, for countdowns. */
  clockOffset: number;
  send: (msg: ClientMessage) => void;
  sendAudio: (pcm: ArrayBuffer) => void;
}

let toastId = 0;

export function useLobby(session: JoinResponse): LobbyConnection {
  const [state, setState] = useState<PublicState | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [word, setWord] = useState<SecretWord | null>(null);
  const [captions, setCaptions] = useState<Record<string, Caption>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [status, setStatus] = useState<LobbyConnection["status"]>("connecting");
  const [fatal, setFatal] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const pushToast = useCallback((text: string, error = false) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-3), { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 5000 : 3500);
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const params = new URLSearchParams({ code: session.code, token: session.token });
      const ws = new WebSocket(`${proto}://${location.host}/ws?${params}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        retry = 0;
        setStatus("open");
      };
      ws.onmessage = (e: MessageEvent<string>) => {
        if (stopped) return;
        const msg = JSON.parse(e.data) as ServerMessage;
        switch (msg.t) {
          case "state":
            setState(msg.state);
            setYou(msg.you);
            setWord(msg.word);
            setClockOffset(msg.serverNow - Date.now());
            break;
          case "caption":
            setCaptions((c) => ({
              ...c,
              [msg.playerId]: { text: msg.text, final: msg.final, matched: msg.matched, at: Date.now() },
            }));
            break;
          case "toast":
            pushToast(msg.text);
            break;
          case "error":
            pushToast(msg.message, true);
            break;
        }
      };
      ws.onclose = (e) => {
        if (stopped) return;
        wsRef.current = null;
        setStatus("closed");
        if (e.code === 4001) {
          setFatal(e.reason || "This lobby doesn't recognize you");
          return;
        }
        timer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [session.code, session.token, pushToast]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const sendAudio = useCallback((pcm: ArrayBuffer) => {
    const ws = wsRef.current;
    // Drop audio rather than queue it if the connection is backed up.
    if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(pcm);
  }, []);

  return { state, you, word, captions, toasts, status, fatal, clockOffset, send, sendAudio };
}

/** Re-renders on an interval and returns the current time. */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
