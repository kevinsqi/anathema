# Anathema

A multiplayer word-describing party game. One player (the describer) gets a secret word and describes it without saying it. The first person to say the word gets a point and becomes the describer.

## Rules

- Correct guess: **+1** for the guesser, who takes the describer seat with a new word.
- Describer says the word or a close form (`flame` for `flames`): **−1**, and they get a new word.
- Describer skips: **−0.5**.
- If nobody guesses within **3 minutes** of a describer taking the seat, there's a short countdown and then the highest scorer becomes the describer (ties broken randomly).
- First to **10** wins. Points to win and the reset timer can be changed in the lobby.
- Words never repeat within a lobby, even across games.
- Anyone can undo the last scoring event, which covers mistakes from auto-detection.

## Playing

Players join with a 5-digit lobby code and a name. Voice happens elsewhere (Discord, FaceTime, …). **Everyone should wear headphones**: each player's mic is transcribed separately, so audio leaking from speakers can be credited to the wrong person.

**Auto-detection.** When a player turns on their mic, their audio streams to the server, which forwards it to Deepgram with the current word boosted as a keyterm. If a guesser says the word, they get the point. If the describer says it, they get the penalty. Live transcripts show up in the sidebar. The manual buttons always work too.

**Mic test.** Open `/mic-test` to see what the recognizer hears and whether it matches a target word.

## Development

Requires Node 22.13+ (for `node:sqlite`) and pnpm.

```bash
pnpm install
cp .env.example .env   # optional: add OPENAI_API_KEY / DEEPGRAM_API_KEY
pnpm dev               # web on http://localhost:5173, API on :8787
pnpm test
pnpm typecheck
```

Without API keys, the game runs with a built-in word list and manual scoring.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Generates themed word lists (100 words per theme and difficulty, topped up automatically when a lobby runs low) |
| `OPENAI_MODEL` | Defaults to `gpt-5-mini` |
| `DEEPGRAM_API_KEY` | Enables speech auto-detection |
| `STT_MIN_CONFIDENCE` | Per-word confidence a transcript needs to count (default `0.5`) |
| `DB_PATH` | SQLite file (default `data/anathema.db`) |

### Layout

```
shared/protocol.ts      message types shared by client and server
server/game/engine.ts   game rules as a pure state machine (unit tested)
server/lobby.ts         wires the engine to sockets, SQLite, word lists and STT
server/db.ts            schema + queries (node:sqlite)
server/words/           word list generation, built-in list, word matching
server/stt/deepgram.ts  streaming speech-to-text client
web/                    React UI (Vite)
```

## Playing over the internet from a laptop

Browsers only allow mic access over HTTPS, so share the game through a tunnel instead of a LAN IP. With [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed (`brew install cloudflared`):

```bash
pnpm build && pnpm start   # serves everything on :3000
pnpm tunnel                # in a second terminal
```

The tunnel prints its public URL in a box near the top of its output (`https://<random-words>.trycloudflare.com`). Share that. Quick tunnels need no account, and the URL changes each run.

If port 3000 is taken, pick another port and pass it to both the server and the tunnel:

```bash
pnpm build && PORT=4000 pnpm start
PORT=4000 pnpm tunnel
```

## Deploying (not set up yet)

Plan: a DigitalOcean droplet running the app with Docker Compose, Caddy in front for automatic HTTPS (`<ip>.sslip.io` works without a domain), and the SQLite file on a mounted volume with a nightly `.backup`.
