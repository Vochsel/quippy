# Deploying quippy.party

Production is split in two, because Vercel functions can't hold the long-lived WebSocket connections a live room needs:

```
 phones + TV ──https──▶ quippy.party          Vercel: static site (public/ + game screens)
           └──wss/https──▶ live.quippy.party   Cloudflare Worker: API + one Durable Object per room
                                                  ├─ D1  "quippy"        profiles, stats, crews, lore, games, answers
                                                  ├─ R2  "quippy-media"  cached voice-over audio
                                                  └─ Vercel AI Gateway   Callback Club's brain
```

The same game code also runs as a single Node process (`npm start`) for LAN parties and development.

## 1. Cloudflare (live server)

Needs a Cloudflare account; `quippy.party` should be a zone in that account if you want the `live.quippy.party` custom domain (otherwise use the `*.workers.dev` URL wrangler prints).

```bash
npx wrangler@4 login
```

```bash
npx wrangler@4 d1 create quippy
```

Copy the printed `database_id` into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`). Tables are created automatically on first request.

```bash
npx wrangler@4 r2 bucket create quippy-media
```

Secrets (each command prompts for the value):

```bash
npx wrangler@4 secret put AI_GATEWAY_API_KEY
```

```bash
npx wrangler@4 secret put ELEVENLABS_API_KEY
```

```bash
npx wrangler@4 secret put ELEVENLABS_VOICE_ID
```

(The two ElevenLabs secrets are optional; without them the TV uses its browser's speech voices.)

Deploy:

```bash
npm run cf:deploy
```

`wrangler.toml` already routes `live.quippy.party` to the Worker as a custom domain and sets `PUBLIC_URL=https://quippy.party` (used in QR codes) and `ALLOWED_ORIGINS`. Check it: `https://live.quippy.party/api/config` should return JSON.

To try the Worker locally first: `npm run cf:dev` (local D1/R2/Durable Objects), then `QUIPPY_LIVE_URL=http://localhost:8787 npm run build` and serve `dist/`.

## 2. Vercel (website)

1. Import the GitHub repo into Vercel. Framework preset: **Other**. `vercel.json` sets the build (`npm run build`) and output (`dist/`).
2. Environment variable: `QUIPPY_LIVE_URL = https://live.quippy.party` (Production + Preview).
3. Domains: add `quippy.party` (and `www.quippy.party` redirecting to it). If DNS is on Cloudflare, add the records Vercel shows you (typically `A @ 76.76.21.21` and `CNAME www cname.vercel-dns.com`) with the proxy **off** (grey cloud).

`vercel.json` rewrites `/host`, `/play` and any 4-letter path (`quippy.party/ABCD`) to the right page, so the QR code on the TV opens straight into the join screen.

## 3. The AI brain over time

Callback Club talks to any OpenAI-compatible endpoint. Set `LLM_PROVIDER` (in `wrangler.toml` for production, `.env` locally):

| setting | use |
|---|---|
| `vercel` + `AI_GATEWAY_API_KEY` | production default. Pick a model with `LLM_MODEL` in gateway form, e.g. `anthropic/claude-opus-5.5` (default), `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5`, or any other provider's model the gateway lists. Swap models without code changes. |
| `ollama` / `lmstudio` | local model on the same machine as the Node server (LAN parties, no internet, no cost). `auto` finds them on their default ports. |
| `openai-compatible` + `LLM_BASE_URL` (+ `LLM_API_KEY`) | anything else: llama.cpp server, vLLM, a tunnel to your home Ollama box, OpenRouter... |
| `none` | never call a model; Callback Club uses its built-in template brain |

A Cloudflare Worker can't reach `localhost`, so production uses the gateway (or an `openai-compatible` URL you expose). Every AI call has a fallback, so a slow or failing model never stalls a game; the TV shows which brain is active and its last error on hover.

## 4. Data, sessions and restarts

- Rooms snapshot to their Durable Object's storage after every phase change, so deploys and evictions resume mid-game; phones and the TV reconnect by themselves.
- A crew is one TV (its `hostId` in localStorage). Its Lore Book, Hall of Fame and leaderboard live in D1 forever. Reopening `/host` on that TV resumes its open room for 24h (`QUIPPY_ROOM_TTL_HOURS`), then starts a fresh one with the same crew memory.
- Players are identified by a device id (localStorage + cookie). If that's wiped, a soft fingerprint lets the phone offer "Welcome back, Bazza?" — the player confirms, nothing is merged silently, and people already connected in the room are never suggested.
