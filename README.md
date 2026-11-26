# Quippy 🎤

A couch party-game platform. The TV is the stage, everyone's phone is the controller: scan the QR code, type a name, play. No apps, no accounts.

**Live at [quippy.party](https://quippy.party)** once deployed (see [docs/DEPLOY.md](docs/DEPLOY.md)).

## Games

- **Zinger Duel**: the classic. Two players get the same prompt and secretly write the funniest answer they can; everyone else votes. Round 2 is double points. The Final Showdown gives everyone one prompt and lets them vote for their favourites (no acronym round). Shutouts, a panic button, awards, and a podium.
- **Callback Club**: the AI mode. Same format, but the prompts are written live for *your* crew. Round 1 is tailor-made around the players and the crew's Lore Book. Round 2 calls back to tonight's best answers. The final is a Grand Callback to the biggest joke of the night. It adapts when people are struggling (lots of panic buttons means simpler prompts), and the host reacts to every matchup with a fresh one-liner. It runs on a local LLM (Ollama / LM Studio) or the Vercel AI Gateway, and falls back to a template brain when neither is available.

Make your own with `npm run new-game` — see [docs/MAKING_GAMES.md](docs/MAKING_GAMES.md).

## What's in the box

- **QR join**: the TV shows a big room code and QR; phones land straight on the join screen. Pick a name, colour and one of 8 blob characters in 12 colours. 3–8 players, plus an audience that can vote. The first player is the 👑 VIP and can start games from their phone.
- **Survives restarts**: every room snapshots itself after each phase change (SQLite locally, Durable Objects in production). Kill the server mid-vote, restart it, and the TV and phones reconnect and carry on where they were.
- **Remembers everything**:
  - **Per person** (device id + soft fingerprint recovery): games, wins, win streaks, points, votes won, shutouts, panic-button habit, and their best line ever.
  - **Per night**: session standings, "line of the night", last game's podium.
  - **Per crew** (one TV = one crew): the **Lore Book** of running jokes and comedic taste (written by the AI, or by a heuristic without one), a Hall of Fame of the greatest answers, and an all-time leaderboard. Callback Club reads the Lore Book back to you, session after session.
- **Big, localised prompt bank**: content packs live in `content/locales/<locale>/`. The default is Australian English (`en-AU`), with 652 prompts, 88 final-round prompts, 129 personalised "{player}" prompts, 167 panic answers, and the host's lines. A crew won't see a prompt twice until it has seen most of the bank. There's a family-friendly toggle.
- **Host voice-over**: Monty, an original dry, deadpan, faintly world-weary host. He reads the prompts and answers and reacts to results, with captions on screen while the music ducks under him. By default he uses the TV browser's speech voices (pick one in ⚙️); set ElevenLabs keys to use a voice of your choosing.
- **Music and sound**: a procedural Web Audio soundtrack with a band per phase (lounge-funk lobby, ticking "thinking" music, suspense for voting, a results groove, a victory fanfare) plus sound effects, all synthesised with no audio files.
- **Configurable answers**: answers can be up to 200 characters by default (80–280 per room, or `QUIPPY_ANSWER_CHARS`). Long answers shrink to fit on the TV and scroll themselves when they still don't fit; the phone text box grows as you type.

## Quick start (local / LAN party)

Needs Node 22.13+.

```bash
npm install
```

```bash
npm start
```

Open the printed `/host` URL on the TV (or a laptop plugged into it), click **Start the show**, and scan the QR with phones on the same Wi-Fi. `npm run dev` adds auto-reload. Use the **+ Bot** button to fill seats while testing.

### Turn on the AI brain

- **Local, free, offline**: install [Ollama](https://ollama.com), run `ollama pull llama3.1` and start Quippy. It finds Ollama (or LM Studio) automatically.
- **Hosted**: put `AI_GATEWAY_API_KEY=...` in `.env` to use the Vercel AI Gateway. It defaults to `anthropic/claude-opus-5.5`; change it with `LLM_MODEL`.

The chip in the top-right of the TV shows which brain is active. All options are listed in [.env.example](.env.example).

### Custom host voice

```
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```

Lines are cached (on disk locally, in R2 in production), so each unique line is synthesised once. Only use a voice you have the rights to; Quippy doesn't clone real people's voices.

## Production

`quippy.party` is served by Vercel (static site). Live rooms run on a Cloudflare Worker with Durable Objects, D1 holds profiles, stats and lore, and R2 holds cached voice audio. Step-by-step instructions are in [docs/DEPLOY.md](docs/DEPLOY.md).

## Project layout

```
core/      shared room / game / storage / AI logic (runs in Node and in Cloudflare)
games/     one folder per game (+ registry.js)
content/   locale packs (en-AU)
server/    Node runtime            worker/   Cloudflare runtime
public/    TV + phone web app       test/     node:test suite
```

`npm test` runs the suite. It simulates a complete game of every registered game with bots, a mid-round restart, and content and stats checks.

## Adding a locale

Copy `content/locales/en-AU` to e.g. `content/locales/en-GB`, rewrite the prompts and host lines, update `meta.json` (`name`, `label`, `flag`, `speechLang`, and `llmHint`, which tells the AI how to write for that audience), and register it in `content/index.js`. Missing files fall back to another pack of the same language, then to the default. Rooms pick their locale in the lobby.
