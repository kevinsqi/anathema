import { useEffect, useState } from "react";
import type { JoinResponse } from "../../shared/protocol.ts";
import { Home } from "./components/Home.tsx";
import { Lobby } from "./components/Lobby.tsx";
import { MicTest } from "./components/MicTest.tsx";
import { clearSession, loadSession, saveSession } from "./session.ts";

export function navigate(path: string): void {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function App() {
  const path = usePath();
  if (path === "/mic-test") return <MicTest />;

  const code = /^\/(\d{5})$/.exec(path)?.[1];
  if (!code) return <Home onJoined={(s) => enter(s)} />;
  return <LobbyRoute key={code} code={code} />;
}

function enter(session: JoinResponse) {
  saveSession(session);
  navigate(`/${session.code}`);
}

function LobbyRoute({ code }: { code: string }) {
  const [session, setSession] = useState(() => loadSession(code));
  if (!session) {
    return (
      <Home
        initialCode={code}
        onJoined={(s) => {
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }
  return (
    <Lobby
      session={session}
      onLeave={() => {
        clearSession(code);
        navigate("/");
      }}
    />
  );
}
