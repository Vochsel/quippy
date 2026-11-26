// Deploy without interrupting anyone's game.
//
//   npm run deploy            deploy now if no game is running, else stop
//   npm run deploy -- --wait  wait (checking every 30s) until no game is running
//
// Order matters: the Worker (live server) goes first, then the website, so a
// freshly loaded page never talks to an older server. Rooms in the lobby are
// fine to deploy over: they snapshot themselves and phones reconnect.
import { execFileSync } from 'node:child_process';

const LIVE = process.env.QUIPPY_LIVE_URL || 'https://live.quippy.party';
const wait = process.argv.includes('--wait');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });

function recentRooms() {
  const out = sh('npx', ['wrangler@4', 'd1', 'execute', 'quippy', '--remote', '--json', '--command',
    "select code from rooms where closed = 0 and updated_at > (strftime('%s','now') - 300) * 1000"]);
  return JSON.parse(out)[0].results.map((r) => r.code);
}

async function liveGames() {
  const games = [];
  for (const code of recentRooms()) {
    const res = await fetch(`${LIVE}/api/rooms/${code}`).catch(() => null);
    const info = res?.ok ? await res.json() : null;
    if (info?.phase === 'game') games.push(`${code} (${info.players} players)`);
  }
  return games;
}

for (;;) {
  const games = await liveGames();
  if (!games.length) break;
  console.log(`${new Date().toLocaleTimeString()}  game in progress: ${games.join(', ')}`);
  if (!wait) {
    console.log('Not deploying. Run `npm run deploy -- --wait` to deploy as soon as it finishes.');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 30000));
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const version = `v0.${git('rev-list', '--count', 'HEAD')} · ${git('rev-parse', '--short', 'HEAD')}`;
console.log(`No games running. Deploying ${version}: live server (Cloudflare)...`);
execFileSync('npx', ['wrangler@4', 'deploy', '--var', `QUIPPY_VERSION:${version}`], { stdio: 'inherit' });
console.log('Deploying the website (Vercel)...');
execFileSync('vercel', ['deploy', '--prod', '--yes', '--build-env', `QUIPPY_VERSION=${version}`], { stdio: 'inherit' });
console.log('Done.');
