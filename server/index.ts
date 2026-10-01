import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";
import { CodeSchema, NameSchema, type ServerMessage } from "../shared/protocol.ts";
import { config } from "./config.ts";
import { openDb, Repo } from "./db.ts";
import { HttpError, LobbyManager } from "./lobby.ts";
import { DeepgramStream, sttAvailable } from "./stt/deepgram.ts";
import { wordGenAvailable } from "./words/generate.ts";
import { buildForms, transcriptMatches } from "./words/matcher.ts";
import { WordLists } from "./words/service.ts";

const repo = new Repo(openDb(config.dbPath));
const lobbies = new LobbyManager({ repo, wordLists: new WordLists(repo) });

const app = Fastify({ logger: { level: config.production ? "info" : "warn" } });
await app.register(fastifyWebsocket);

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
  if (err instanceof z.ZodError) return reply.status(400).send({ error: "Invalid request" });
  app.log.error(err);
  return reply.status(500).send({ error: "Something went wrong" });
});

app.get("/api/config", async () => ({ sttAvailable: sttAvailable(), wordGenAvailable: wordGenAvailable() }));

app.post("/api/lobbies", async (req) => {
  const { name } = z.object({ name: NameSchema }).parse(req.body);
  return lobbies.create(name);
});

app.post("/api/lobbies/:code/join", async (req) => {
  const { code } = z.object({ code: CodeSchema }).parse(req.params);
  const { name, token } = z.object({ name: NameSchema, token: z.string().optional() }).parse(req.body);
  return lobbies.join(code, name, token);
});

app.get("/ws", { websocket: true }, (socket, req) => {
  const { code, token } = req.query as { code?: string; token?: string };
  const auth = code && token ? lobbies.authenticate(code, token) : undefined;
  if (!auth) {
    socket.close(4001, "Unknown lobby or player");
    return;
  }
  auth.room.connect(auth.playerId, socket);
});

// Standalone mic check: stream audio, see what the recognizer hears and whether it matches.
app.get("/ws/mictest", { websocket: true }, (socket, req) => {
  const { word = "" } = req.query as { word?: string };
  const send = (msg: ServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg));
  if (!sttAvailable()) {
    send({ t: "error", message: "DEEPGRAM_API_KEY is not set on the server" });
    socket.close();
    return;
  }
  const forms = buildForms(word, []);
  const stream = new DeepgramStream(
    word ? [word] : [],
    (t) => send({ t: "caption", playerId: "you", text: t.text, final: t.final, matched: Boolean(word) && transcriptMatches(t, forms, config.sttMinConfidence) }),
    (err) => send({ t: "error", message: err.message }),
  );
  socket.on("message", (data, isBinary) => {
    if (isBinary) stream.send(data as Buffer);
  });
  socket.on("close", () => stream.close());
});

const webDist = resolve("dist/web");
if (config.production && existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // Client-side routes like /12345 fall back to the app shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api")) return reply.sendFile("index.html");
    return reply.status(404).send({ error: "Not found" });
  });
}

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`anathema server on http://localhost:${config.port}`);
console.log(`  word generation: ${wordGenAvailable() ? `OpenAI (${config.openaiModel})` : "off (built-in words)"}`);
console.log(`  auto-detection:  ${sttAvailable() ? `Deepgram (${config.deepgramModel})` : "off (manual scoring)"}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    lobbies.dispose();
    void app.close().then(() => process.exit(0));
  });
}
