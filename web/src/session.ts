// Remembers which player this browser is in each lobby, so a refresh rejoins.
import type { JoinResponse } from "../../shared/protocol.ts";

const key = (code: string) => `anathema:session:${code}`;

export function loadSession(code: string): JoinResponse | null {
  try {
    const raw = localStorage.getItem(key(code));
    return raw ? (JSON.parse(raw) as JoinResponse) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: JoinResponse): void {
  try {
    localStorage.setItem(key(session.code), JSON.stringify(session));
  } catch {
    // Storage unavailable; the session lasts until the tab closes.
  }
}

export function clearSession(code: string): void {
  try {
    localStorage.removeItem(key(code));
  } catch {
    // ignore
  }
}

export function loadName(): string {
  try {
    return localStorage.getItem("anathema:name") ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem("anathema:name", name);
  } catch {
    // ignore
  }
}

export async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
