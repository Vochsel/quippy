// Builds the static site for Vercel into dist/: the public/ folder, every
// game's client/ folder, and env.js pointing the browser at the live server.
//   QUIPPY_LIVE_URL=https://live.quippy.party npm run build
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(ROOT, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), out, { recursive: true });

for (const dir of fs.readdirSync(path.join(ROOT, 'games'), { withFileTypes: true })) {
  const client = path.join(ROOT, 'games', dir.name, 'client');
  if (dir.isDirectory() && fs.existsSync(client)) {
    fs.cpSync(client, path.join(out, 'games', dir.name, 'client'), { recursive: true });
  }
}

const live = (process.env.QUIPPY_LIVE_URL || '').replace(/\/+$/, '');
fs.writeFileSync(path.join(out, 'env.js'), `window.QUIPPY = ${JSON.stringify({ live })};\n`);
console.log(`Built dist/ (live server: ${live || 'same origin'})`);
