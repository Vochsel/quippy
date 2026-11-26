# Making a game

Every game is a folder in `games/` with three files and one line in `games/registry.js`:

```
games/my-game/
  index.js           server logic (runs in Node or a Cloudflare Durable Object)
  client/host.js     the TV screen
  client/player.js   the phone screen
```

The quickest start is the scaffold, which writes a small working game you can reshape:

```bash
npm run new-game my-game "My Game"
```

Then run `npm run dev`, open http://localhost:3000/host, add a few bots with **+ Bot**, join from your phone and pick the game. `npm test` plays every registered game with bots to make sure it still finishes.

Vibe-coding tip: point your assistant at this file, `CLAUDE.md` and `games/_quip/engine.js` (a full real game), describe the game you want, and ask it to keep `npm test` green.

## Server module (`index.js`)

```js
export default {
  id: 'my-game',            // unique, also the folder name
  name: 'My Game',
  tagline: 'One line for the lobby card.',
  minPlayers: 3,
  maxPlayers: 8,
  accent: '#ffb23f',        // lobby card stripe
  client: 'my-game',        // folder whose client/ holds the screens (can share another game's)
  usesAi: false,            // shows the 🧠 badge
  create(ctx) { return new Game(ctx, null); },          // fresh game
  restore(ctx, state) { return new Game(ctx, state); }, // after a restart
};
```

The instance:

| method | when |
|---|---|
| `start()` | game begins |
| `resume()` | after a restart/eviction: re-trigger non-timer work (bot moves, in-flight AI calls) |
| `onAction(playerId, payload)` | a phone sent `api.send(payload)` |
| `onHostAction(payload)` | the TV sent an action (optional) |
| `onTimer(name)` | a `ctx.setTimer(name, ms)` fired |
| `onContinue()` | VIP/host tapped "continue" (optional; skip ahead / leave game over) |
| `hostView()` | JSON for the TV. Include `deadline`, `timer: true`, `timerTotal` to show the countdown ring |
| `playerView(playerId)` | JSON for one phone |
| `serialize()` | the whole state as plain JSON |

### `ctx` (what the platform gives your game)

| | |
|---|---|
| `ctx.roster()` | player ids in this game (fixed at start) |
| `ctx.audienceIds()` | connected non-players who can still vote |
| `ctx.player(id)`, `ctx.playerName(id)`, `ctx.publicPlayer(id)` | player info (`{id, name, color, face, isBot}`) |
| `ctx.isConnected(id)`, `ctx.isBot(id)` | |
| `ctx.update()` | broadcast new views + schedule a save |
| `ctx.checkpoint()` | save immediately (call on phase changes) |
| `ctx.setTimer(name, ms)` → deadline, `ctx.clearTimer(name)`, `ctx.timerDeadline(name)` | persisted timers |
| `ctx.later(ms, fn)` | non-persisted delay (bots, effects) |
| `ctx.say(text)`, `ctx.line(key, vars)`, `ctx.sayLine(key, vars)` | host voice-over + caption; lines come from the locale's `host.json` |
| `ctx.sfx(name)` | `join select submit vote whoosh reveal shutout buzzer tick fanfare` |
| `ctx.music(track)` | `lobby intro writing voting results final victory` |
| `ctx.buzz(ids, pattern)` | vibrate phones (`null` = everyone) |
| `ctx.content` | the room's locale pack: `pickPrompts(n, used)`, `pickFinal()`, `pickPersonal()`, `panic()`, `line()`, `meta` |
| `ctx.usedPrompts`, `ctx.markPromptsUsed(keys)` | so a crew doesn't see the same prompt twice |
| `ctx.llm` | `available()`, `json({ system, user, maxTokens })` → parsed JSON. Always have a fallback. |
| `ctx.lore()` | the crew's Lore Book (`{ jokes, taste }`) |
| `ctx.settings` | room settings (`locale`, `family`, `answerSeconds`, `answerChars`) |
| `ctx.timing` | default phase lengths |
| `ctx.finish(results)` | end the game (see below) |

### Results contract

`ctx.finish(results)` records stats, session standings, the Hall of Fame and the Lore Book:

```js
{
  gameType: 'my-game',
  players: [{ id, name, color, face, isBot, score, rank, counters: { anyTally: 3 }, best: { prompt, answer, votes, totalVotes } | null }],
  winnerIds: ['p_...'],
  answers: [{ playerId, playerName, round, prompt, answer, votes, totalVotes, won, panic }], // feeds the Lore Book
  highlights: [{ name, prompt, answer, votes, totalVotes }],
  awards: [{ key, title, playerId, name, value }],
}
```

`counters` are summed into each player's lifetime stats, so invent whatever is fun to track.

## Client modules

Both export `mount(root, api)` returning `{ update(view, room, me), destroy() }`. `update` is called on every state change; re-render only what changed (see `games/_quip/client/host.js` for the key-and-patch pattern).

`api` includes `h` (safe DOM builder), `mountInto`, `avatar(player, size)`, `fmt(number)`, `send(payload)` (→ `onAction`), `action('continue')`, `serverNow()`, and on the TV `confetti()`, `audio`, `room()`, `isOwner()`; on phones `vibrate()`, `toast()`.

Shared styles in `public/css/quippy.css` give you `.card`, `.btn` (`.pink .teal .white .lime .big .block`), `.chip`, `.pop-in`, `.slide-up`, `.slam`, `.wiggle`.

## Words and localisation

Put text the host says or phones show into `content/locales/<locale>/host.json` under your own keys and use `ctx.line('myKey', { name })`. Prompt-style content can go in its own file in the pack; register it in `content/index.js`.
