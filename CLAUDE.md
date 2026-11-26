# Quippy — notes for AI coding assistants

Quippy is a couch party-game platform: a TV runs `/host`, phones join at `/<CODE>` (QR on the TV). Games are plugins. Read this before changing things.

## Layout

```
core/            runtime-agnostic logic (no Node- or Worker-only APIs here)
  room.js        lobby, players, VIP, session standings, game lifecycle, views, snapshots
  sqlstore.js    all SQL (SQLite dialect: node:sqlite locally, Cloudflare D1 in prod)
  llm.js         OpenAI-compatible chat client (Ollama / LM Studio / Vercel AI Gateway)
  content.js     locale content packs (prompts, host lines) with fallback
  profiles.js    device-id identity, fingerprint "welcome back", lifetime stats
  lore.js        the crew's Lore Book (running jokes), AI or heuristic updates
  api.js         HTTP API shared by both runtimes
games/
  registry.js    the list of games (add an import here)
  _quip/         shared engine + screens for prompt-duel games
  zinger-duel/   classic game: prompts from the locale bank
  callback-club/ AI game: brain.js writes prompts/callbacks/host quips
content/locales/<locale>/   prompts.json, final.json, personal.json, panic.json, callbacks.json, host.json, meta.json
server/          Node runtime (express + ws + node:sqlite) — local/LAN play
worker/          Cloudflare runtime (Worker + one Durable Object per room, D1, R2)
public/          static site (TV shell, phone shell, shared libs) — deployed to Vercel
test/            node:test suite — simulates full games with bots + mocked timers
```

## Rules of thumb

- **Game state must be plain JSON in one object** (`this.s`) and returned by `serialize()`. Rooms snapshot after every change and resume after restarts/evictions; anything not in `this.s` is lost.
- **Timers that matter use `ctx.setTimer(name, ms)`** (persisted, re-armed on resume, delivered to `onTimer(name)`). `ctx.later(ms, fn)` is only for cosmetic delays and bot moves; re-trigger those in `resume()`.
- After changing state call `ctx.update()` (broadcasts views, schedules a save). Call `ctx.checkpoint()` on big phase changes for an immediate save.
- Views are per-audience: `hostView()` for the TV, `playerView(id)` for each phone. Never put secrets (e.g. who wrote an anonymous answer) in a view before it's revealed.
- Player text is untrusted: clean it with `cleanText()` server-side; render it with `h()` (text nodes), never `innerHTML`.
- `core/` must stay runtime-agnostic: only `fetch`, `crypto`, timers, `queueMicrotask`. Node-only code goes in `server/`, Cloudflare-only in `worker/`.
- User-facing words for games live in the locale pack (`content/locales/en-AU/host.json`), not in code, so they can be localised. Australian English is the default (`en-AU`).
- Bots must be able to play every game: `npm test` plays each registered game with bots and fails if it never finishes.

## Commands

- `npm run dev` — Node server with auto-reload and dev tools (`+ Bot` button). TV: http://localhost:3000/host
- `npm test` — fast suite (full simulated games, restart survival, content checks)
- `npm run new-game <id> "<Name>"` — scaffold a working game and register it
- `npm run build` — static site into `dist/` for Vercel (`QUIPPY_LIVE_URL` points it at the Worker)
- `npm run deploy` — deploy Worker then website, refusing while a game is live (`-- --wait` to wait). Prefer this over `cf:deploy`/`vercel deploy`: deploys restart rooms
- `npm run cf:dev` / `npm run cf:deploy` — Cloudflare Worker locally / to production (unguarded)

See `docs/MAKING_GAMES.md` for the game API and `docs/DEPLOY.md` for production.
