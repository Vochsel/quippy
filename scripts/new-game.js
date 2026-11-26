// Scaffold a new game: `npm run new-game my-game "My Game"`.
// Creates games/<id>/ with a tiny but complete working game ("pick a side,
// score if you're in the majority") and registers it in games/registry.js.
// Then edit it into whatever you like — `npm test` plays every registered
// game with bots to check it still runs start to finish.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [id, ...nameParts] = process.argv.slice(2);
if (!id || !/^[a-z][a-z0-9-]{2,30}$/.test(id)) {
  console.error('Usage: npm run new-game <id> "<Display Name>"   (id: lowercase letters, digits, dashes)');
  process.exit(1);
}
const name = nameParts.join(' ') || id.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
const dir = path.join(ROOT, 'games', id);
if (fs.existsSync(dir)) { console.error(`games/${id} already exists`); process.exit(1); }
const camel = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

const server = `// ${name}: everyone picks a side; whoever lands in the majority scores.
// Server-side game logic. All state lives in this.s (plain JSON) so the game
// survives restarts. See docs/MAKING_GAMES.md for the full ctx API.
import { cleanText, pick, shuffle } from '../../core/util.js';

const ROUNDS = 3;
const QUESTIONS = [
  ['A meat pie at the footy', 'A snag at Bunnings'],
  ['Christmas lunch: hot roast', 'Christmas lunch: cold seafood'],
  ['Magpie season', 'Drop bear season'],
  ['Thongs to a wedding', 'Socks with sandals at the beach'],
  ['Sydney', 'Melbourne'],
];

class Game {
  constructor(ctx, state) {
    this.ctx = ctx;
    this.s = state || {
      phase: 'question', round: 0, roster: ctx.roster(), scores: {}, deck: shuffle(QUESTIONS).slice(0, ROUNDS),
      picks: {}, deadline: null, last: null,
    };
  }

  serialize() { return this.s; }

  start() {
    for (const id of this.s.roster) this.s.scores[id] = 0;
    this.ctx.music('writing');
    this.ctx.say('Pick a side. If you end up with the majority, you score. Simple as.');
    this.#question();
  }

  // Called after a restart: re-trigger anything that isn't a timer (e.g. bots).
  resume() { if (this.s.phase === 'question') this.#bots(); }

  #question() {
    const s = this.s;
    s.phase = 'question';
    s.picks = {};
    s.deadline = this.ctx.setTimer('question', 20000);
    const [a, b] = s.deck[s.round];
    this.ctx.say(\`\${a}... or \${b}?\`);
    this.ctx.update();
    this.#bots();
  }

  #bots() {
    for (const id of this.s.roster.filter((x) => this.ctx.isBot(x))) {
      this.ctx.later(1000 + Math.random() * 4000, () => this.onAction(id, { type: 'pick', side: pick(['A', 'B']) }));
    }
  }

  onAction(playerId, p) {
    const s = this.s;
    if (s.phase !== 'question' || p.type !== 'pick' || !['A', 'B'].includes(p.side)) return;
    if (!s.roster.includes(playerId) || s.picks[playerId]) return;
    s.picks[playerId] = p.side;
    this.ctx.sfx('vote');
    if (s.roster.every((id) => s.picks[id])) this.#reveal();
    else this.ctx.update();
  }

  onTimer(name) {
    if (name === 'question') this.#reveal();
    if (name === 'reveal') {
      this.s.round += 1;
      if (this.s.round < this.s.deck.length) this.#question();
      else this.#finish();
    }
  }

  #reveal() {
    const s = this.s;
    this.ctx.clearTimer('question');
    const a = Object.values(s.picks).filter((x) => x === 'A').length;
    const b = Object.values(s.picks).filter((x) => x === 'B').length;
    const majority = a === b ? null : a > b ? 'A' : 'B';
    for (const [id, side] of Object.entries(s.picks)) if (side === majority) s.scores[id] += 100;
    s.last = { a, b, majority };
    s.phase = 'reveal';
    s.deadline = this.ctx.setTimer('reveal', 6000);
    this.ctx.sfx('reveal');
    this.ctx.say(majority ? 'The people have spoken.' : 'Dead even. Nobody scores. Typical.');
    this.ctx.update();
  }

  #ranking() {
    return [...this.s.roster].sort((x, y) => this.s.scores[y] - this.s.scores[x])
      .map((id, i, arr) => ({ id, score: this.s.scores[id], rank: arr.findIndex((o) => this.s.scores[o] === this.s.scores[id]) + 1 }));
  }

  #finish() {
    const ranking = this.#ranking();
    // The results contract every game hands back (see docs/MAKING_GAMES.md).
    this.ctx.finish({
      gameType: '${id}',
      players: ranking.map((r) => ({ ...this.ctx.publicPlayer(r.id), score: r.score, rank: r.rank, counters: {} })),
      winnerIds: ranking.filter((r) => r.rank === 1 && r.score > 0).map((r) => r.id),
      answers: [],
      highlights: [],
      awards: [],
    });
  }

  hostView() {
    const s = this.s;
    const [a, b] = s.deck[s.round] || ['', ''];
    return {
      phase: s.phase, round: s.round + 1, rounds: s.deck.length, deadline: s.deadline, timer: s.phase === 'question',
      timerTotal: 20000, a, b, last: s.last, picked: Object.keys(s.picks).length, total: s.roster.length,
      scoreboard: this.#ranking().map((r) => ({ ...this.ctx.publicPlayer(r.id), score: r.score })),
    };
  }

  playerView(playerId) {
    const s = this.s;
    const [a, b] = s.deck[s.round] || ['', ''];
    return {
      phase: s.phase, deadline: s.deadline, timer: s.phase === 'question', timerTotal: 20000,
      a: cleanText(a), b: cleanText(b), picked: s.picks[playerId] || null, inGame: s.roster.includes(playerId),
      score: s.scores[playerId] || 0,
    };
  }
}

export default {
  id: '${id}',
  name: ${JSON.stringify(name)},
  tagline: 'Pick a side. Land in the majority. Score.',
  minPlayers: 3,
  maxPlayers: 12,
  accent: '#ffb23f',
  client: '${id}',
  create: (ctx) => new Game(ctx, null),
  restore: (ctx, state) => new Game(ctx, state),
};
`;

const host = `// TV screen for ${name}. mount(root, api) -> { update(view, room), destroy() }
export function mount(root, api) {
  const { h, avatar, fmt } = api;
  return {
    update(g) {
      const cards = [['A', g.a, g.last?.a], ['B', g.b, g.last?.b]].map(([k, text, n]) => h(\`div.card\${g.last?.majority === k && g.phase === 'reveal' ? '.pop-in' : ''}\`,
        { style: { flex: 1, textAlign: 'center', fontSize: '2.6rem', background: g.phase === 'reveal' && g.last?.majority === k ? 'var(--yellow)' : '' } },
        h('div', { style: { fontFamily: 'var(--head)' } }, k), text, g.phase === 'reveal' ? h('div', { style: { fontSize: '1.6rem' } }, \`\${n} votes\`) : null));
      root.replaceChildren(h('div', { style: { maxWidth: '80rem', margin: '2rem auto', textAlign: 'center' } },
        h('h2', { style: { fontFamily: 'var(--head)', fontSize: '3.4rem', margin: '0 0 2rem' } }, \`Round \${g.round} of \${g.rounds}\`),
        h('div', { style: { display: 'flex', gap: '3rem' } }, cards),
        h('p', { style: { fontSize: '1.6rem' } }, g.phase === 'question' ? \`\${g.picked} / \${g.total} picked\` : ''),
        h('div', { style: { display: 'flex', gap: '1.4rem', justifyContent: 'center', marginTop: '2rem' } },
          g.scoreboard.map((p) => h('div', avatar(p, '4rem'), h('div', p.name), h('b', fmt(p.score)))))));
    },
    destroy() {},
  };
}
`;

const player = `// Phone screen for ${name}. mount(root, api) -> { update(view, room, me), destroy() }
export function mount(root, api) {
  const { h, mountInto } = api;
  return {
    update(g) {
      if (g.phase !== 'question' || !g.inGame) {
        mountInto(root, h('div.ph-watch', h('div.emoji', '📺'), h('p', g.inGame ? 'Eyes on the TV!' : 'Watching')));
        return;
      }
      mountInto(root, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', paddingTop: '1rem' } },
        h('h2', 'Pick a side'),
        ['A', 'B'].map((side) => h(\`button.btn.block.big\${g.picked === side ? '.lime' : '.white'}\`, {
          disabled: !!g.picked, onClick: () => api.send({ type: 'pick', side }),
        }, side === 'A' ? g.a : g.b))));
    },
    destroy() {},
  };
}
`;

fs.mkdirSync(path.join(dir, 'client'), { recursive: true });
fs.writeFileSync(path.join(dir, 'index.js'), server);
fs.writeFileSync(path.join(dir, 'client', 'host.js'), host);
fs.writeFileSync(path.join(dir, 'client', 'player.js'), player);

const regFile = path.join(ROOT, 'games', 'registry.js');
let reg = fs.readFileSync(regFile, 'utf8');
reg = reg.replace(/(\nexport const GAMES = \[)/, `import ${camel} from './${id}/index.js';\n$1`);
reg = reg.replace(/export const GAMES = \[([^\]]*)\]/, (m, list) => `export const GAMES = [${list.trim()}, ${camel}]`);
fs.writeFileSync(regFile, reg);

console.log(`Created games/${id}/ and registered it in games/registry.js.`);
console.log('Next: npm run dev, open /host, pick the game. npm test plays it with bots.');
