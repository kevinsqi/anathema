import { useState, type FormEvent } from "react";
import type { JoinResponse } from "../../../shared/protocol.ts";
import { api, loadName, saveName } from "../session.ts";

export function Home({ initialCode, onJoined }: { initialCode?: string; onJoined: (s: JoinResponse) => void }) {
  const [name, setName] = useState(loadName);
  const [code, setCode] = useState(initialCode ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<JoinResponse>) => {
    setError(null);
    if (!name.trim()) return setError("Enter a name first");
    setBusy(true);
    try {
      saveName(name.trim());
      onJoined(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{5}$/.test(code)) return setError("Lobby codes are 5 digits");
    void run(() => api<JoinResponse>(`/api/lobbies/${code}/join`, { name: name.trim() }));
  };

  return (
    <main className="home">
      <h1>Anathema</h1>
      <p className="tagline">Describe the word. Don’t say the word.</p>

      <div className="card stack">
        <label className="field">
          <span>Your name</span>
          <input value={name} maxLength={24} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" />
        </label>

        <form className="row" onSubmit={join}>
          <input
            className="code-input"
            value={code}
            inputMode="numeric"
            maxLength={5}
            placeholder="12345"
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          <button type="submit" disabled={busy}>
            Join lobby
          </button>
        </form>

        {!initialCode && (
          <>
            <div className="divider">or</div>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(() => api<JoinResponse>("/api/lobbies", { name: name.trim() }))}
            >
              Create a new lobby
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      <p className="muted small">
        Voice chat happens on Discord/FaceTime. Wear headphones so your mic only hears you.{" "}
        <a href="/mic-test">Test your mic</a>
      </p>
    </main>
  );
}
