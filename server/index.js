// Node runtime: one process serving the web app, the API and WebSocket rooms.
// Use it for local development, LAN parties (TV + phones on the same Wi-Fi,
// optional local LLM via Ollama / LM Studio) or any always-on box.
//
//   npm start        then open http://localhost:3000/host on the TV
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { DatabaseSync } from 'node:sqlite';

import { config, ROOT } from './config.js';
import { gitVersion } from '../scripts/version.js';
import { handleApi } from '../core/api.js';
import { ContentLibrary } from '../core/content.js';
import { LLM } from '../core/llm.js';
import { Tts } from '../core/tts.js';
import { ImageGen } from '../core/images.js';
import { Room } from '../core/room.js';
import { SqlStore } from '../core/sqlstore.js';
import { makeRoomCode, ROOM_CODE_RE, uid } from '../core/util.js';
import { PACKS } from '../content/index.js';

if (config.version === 'dev') config.version = `${gitVersion()} (local)`;
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ------------------------------------------------------------------ storage
function sqliteDriver(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  return {
    all: async (sql, params) => stmt(sql).all(...params),
    get: async (sql, params) => stmt(sql).get(...params) ?? null,
    run: async (sql, params) => stmt(sql).run(...params),
  };
}

const store = new SqlStore(sqliteDriver(path.join(config.dataDir, 'quippy.db')));
await store.init();

const ttsDir = path.join(config.dataDir, 'tts');
fs.mkdirSync(ttsDir, { recursive: true });
const ttsCache = {
  get: async (key) => {
    const f = path.join(ttsDir, path.basename(key));
    return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
  },
  put: async (key, bytes) => fs.writeFileSync(path.join(ttsDir, path.basename(key)), bytes),
};

// Uploaded media (profile photos, game images): data/media/<key>
const mediaDir = path.join(config.dataDir, 'media');
const media = {
  get: async (key) => {
    const f = path.join(mediaDir, key.replace(/\.\.+/g, ''));
    return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
  },
  put: async (key, bytes) => {
    const f = path.join(mediaDir, key.replace(/\.\.+/g, ''));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bytes);
  },
};

const llm = new LLM(config.llm);
const tts = new Tts(config.voice, ttsCache);
const images = new ImageGen(config.image);
const content = new ContentLibrary(PACKS, config.defaultLocale);

// --------------------------------------------------------------- join URLs
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const score = /^192\.168\./.test(a.address) ? 3 : /^10\./.test(a.address) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : 0;
      candidates.push({ address: a.address, score: score - (/docker|veth|br-|vmnet|utun/i.test(name) ? 5 : 0) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || 'localhost';
}
const baseUrl = config.publicUrl || `http://${lanAddress()}:${config.port}`;
const joinUrl = (code) => `${baseUrl}/${code}`;

// ------------------------------------------------------------------- rooms
const rooms = new Map(); // code -> Room
const loading = new Map(); // code -> Promise<Room|null>
const ttlMs = config.roomTtlHours * 3600 * 1000;

function deps() {
  return {
    store, llm, config, content, joinUrl, log, tts, media, images,
    persist: async (snapshot) => {
      await store.saveRoom(snapshot.code, snapshot.crewId, snapshot);
      if (process.env.QUIPPY_DEBUG) log(`saved ${snapshot.code} game=${snapshot.game?.phase || '-'}`);
    },
  };
}

async function getRoom(code) {
  if (rooms.has(code)) return rooms.get(code);
  if (!loading.has(code)) {
    loading.set(code, (async () => {
      const row = await store.getRoom(code);
      if (!row || row.closed || !row.state?.code) return null;
      const room = new Room({ code, crewId: row.crewId, deps: deps(), snapshot: row.state });
      await room.init();
      rooms.set(code, room);
      log(`room ${code} restored from storage`);
      return room;
    })().finally(() => loading.delete(code)));
  }
  return loading.get(code);
}

async function createRoom(hostId, { fresh } = {}) {
  await store.ensureCrew(hostId);
  const since = Date.now() - ttlMs;
  if (!fresh) {
    const existing = await store.openRoomForCrew(hostId, since);
    if (existing && (await getRoom(existing))) return { code: existing, joinUrl: joinUrl(existing), resumed: true };
  }
  let code;
  do code = makeRoomCode(); while (rooms.has(code) || (await store.roomCodeTaken(code)));
  const room = new Room({ code, crewId: hostId, deps: deps() });
  await room.init();
  rooms.set(code, room);
  await room.saveNow();
  log(`room ${code} created`);
  return { code, joinUrl: joinUrl(code), resumed: false };
}

// Reopen one of this crew's earlier rooms (any age): it becomes the TV's current room.
async function reopenRoom(hostId, code) {
  const row = await store.getRoom(code);
  if (!row || row.crewId !== hostId || !row.state?.code) return null;
  await store.reopenRoom(code);
  if (!(await getRoom(code))) return null;
  return { code, joinUrl: joinUrl(code), resumed: true };
}

async function roomInfo(code) {
  const room = await getRoom(code);
  if (!room) return null;
  const humans = room.publicPlayers().filter((p) => !p.isBot);
  return {
    code, players: humans.length, phase: room.game ? 'game' : 'lobby',
    names: humans.map((p) => p.name).slice(0, 8), // internal; stripped from the public API
    connectedIds: humans.filter((p) => p.connected).map((p) => p.id), // internal; stripped from the public API
  };
}

// Forget idle rooms from memory (their snapshots stay in SQLite).
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.connectionCount() === 0 && !room.game && Date.now() - (room.lastActive || 0) > 30 * 60 * 1000) {
      room.saveNow().catch(() => {});
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000).unref();

// --------------------------------------------------------------------- http
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '700kb' }));

app.use('/api', async (req, res) => {
  try {
    const out = await handleApi(
      { method: req.method, path: `/api${req.path}`, body: req.body, query: req.query },
      { store, config, llm, content, tts, media, rooms: { create: createRoom, info: roomInfo, reopen: reopenRoom } },
    );
    if (!out) return res.status(404).json({ error: 'not found' });
    if (out.headers) res.set(out.headers);
    if (out.json !== undefined) return res.status(out.status).json(out.json);
    return res.status(out.status).send(out.body ? Buffer.from(out.body) : undefined);
  } catch (e) {
    log('api error', e);
    return res.status(500).json({ error: 'server error' });
  }
});

const pub = path.join(ROOT, 'public');
app.get('/env.js', (req, res) => res.type('js').send(`window.QUIPPY = ${JSON.stringify({ live: '', version: config.version })};`));
app.get('/host', (req, res) => res.sendFile(path.join(pub, 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(pub, 'play.html')));
app.get(/^\/[A-Za-z]{4}\/?$/, (req, res) => res.sendFile(path.join(pub, 'play.html')));
// Game screens live next to their server code: games/<id>/client/*
app.use('/games', (req, res, next) => {
  if (!/^\/[\w-]+\/client\/[\w./-]+$/.test(req.path) || req.path.includes('..')) return res.status(404).end();
  return res.sendFile(path.join(ROOT, 'games', req.path), (err) => err && next());
});
app.use(express.static(pub, { extensions: ['html'] }));

const server = http.createServer(app);

// ---------------------------------------------------------------- websockets
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
server.on('upgrade', async (req, socket, head) => {
  const m = req.url.match(/^\/ws\/([A-Za-z]{4})(?:\?.*)?$/);
  const code = m?.[1]?.toUpperCase();
  if (!code || !ROOM_CODE_RE.test(code)) return socket.destroy();
  const room = await getRoom(code).catch(() => null);
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!room) {
      ws.close(4004, 'no such room');
      return;
    }
    const conn = {
      id: uid('c_'),
      send: (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj)),
      sendRaw: (str) => ws.readyState === 1 && ws.send(str),
      close: () => ws.close(),
    };
    room.attach(conn);
    room.lastActive = Date.now();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      room.lastActive = Date.now();
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      room.onMessage(conn, msg);
    });
    ws.on('close', () => room.detach(conn));
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000).unref();

// --------------------------------------------------------------- lifecycle
async function shutdown(signal) {
  log(`${signal}: saving ${rooms.size} room(s)...`);
  await Promise.allSettled([...rooms.values()].map((r) => r.saveNow()));
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(config.port, () => {
  log(`Quippy is live.`);
  log(`  TV / host screen:  ${baseUrl}/host`);
  log(`  Phones join at:    ${baseUrl}  (or scan the QR on the TV)`);
  llm.init().then(() => {
    const st = llm.status();
    log(st.available ? `  AI brain:          ${st.label} · ${st.model}` : `  AI brain:          built-in templates${st.lastError ? ` (${st.lastError})` : ''}`);
  });
  tts.status().then((v) => log(`  Host voice:        ${v.label}${v.voice ? ` · ${v.voice}` : ''}`));
  log(`  Images:            ${images.available() ? `AI Gateway · ${config.image.model}` : 'placeholders (no AI_GATEWAY_API_KEY or IMAGE_PROVIDER=none)'}`);
});
