// The small HTTP API, shared by the Node server and the Cloudflare Worker.
// Returns { status, json } or { status, body, headers }, or null if the path
// isn't an API route.
import { GAMES } from '../games/registry.js';
import { identify, publicProfile, PHOTO_RE } from './profiles.js';
import { loreSummary } from './lore.js';
import { EXT_TYPE, MEDIA_KEY_RE } from './images.js';

import { ROOM_CODE_RE, sha256Hex } from './util.js';

const ID_RE = /^[\w-]{6,64}$/;
const ok = (json) => ({ status: 200, json });
const bad = (message, status = 400) => ({ status, json: { error: message } });

// deps: { store, config, llm, content, tts (Tts router), rooms: { create(hostId), info(code) } }
export async function handleApi(req, deps) {
  const { method, path } = req;
  const body = req.body || {};
  const { store, config, llm, content } = deps;
  let m;
  // Analytics (PostHog): fire and forget, kept alive by waitUntil on Cloudflare.
  const track = (id, event, props) => {
    const p = deps.analytics?.capture(id, event, props);
    if (p) deps.waitUntil ? deps.waitUntil(p) : p.catch(() => {});
  };

  if (method === 'GET' && path === '/api/tts' && !(req.query || {}).t) {
    return ok(await deps.tts.status());
  }

  if (method === 'GET' && path === '/api/config') {
    await llm.init();
    return ok({
      voice: await deps.tts.status(),
      llm: llm.status(),
      locales: content.locales(),
      defaultLocale: config.defaultLocale,
      speechLang: content.pack(config.defaultLocale).meta.speechLang || 'en-AU',
      countdown: Object.fromEntries([5, 4, 3, 2, 1].map((n) => [n, content.pack(config.defaultLocale).host[`count${n}`]?.[0] || String(n)])),
      games: GAMES.map((g) => ({ id: g.id, name: g.name, tagline: g.tagline, usesAi: !!g.usesAi })),
      publicUrl: config.publicUrl || null,
      dev: config.dev,
      version: config.version,
    });
  }

  if (method === 'POST' && path === '/api/rooms') {
    if (!ID_RE.test(body.hostId || '')) return bad('hostId required');
    const code = typeof body.code === 'string' ? body.code.toUpperCase() : '';
    if (code) {
      if (!ROOM_CODE_RE.test(code)) return bad('bad code');
      const reopened = await deps.rooms.reopen(body.hostId, code);
      if (!reopened) return bad('That room isn’t one of this TV’s rooms.', 404);
      track(body.hostId, 'room_reopened', { room: code });
      return ok(reopened);
    }
    const made = await deps.rooms.create(body.hostId, { fresh: !!body.fresh });
    track(body.hostId, made.resumed ? 'room_resumed' : 'room_created', { room: made.code, fresh: !!body.fresh });
    return ok(made);
  }

  // The crew stats page (TV lobby): everything this room's crew has played.
  // The room code is enough: it's what's on the TV for everyone to see.
  if (method === 'GET' && (m = path.match(/^\/api\/rooms\/([A-Za-z]{4})\/stats$/))) {
    const code = m[1].toUpperCase();
    const row = ROOM_CODE_RE.test(code) ? await store.getRoom(code) : null;
    if (!row?.crewId) return bad('No room with that code.', 404);
    return ok(await store.crewStats(row.crewId));
  }

  // Restart a room on a fresh process, keeping its code, players and tonight's
  // scores (seed = the TV's current lobby view). TV owner only.
  if (method === 'POST' && path === '/api/rooms/restart') {
    const code = typeof body.code === 'string' ? body.code.toUpperCase() : '';
    if (!ID_RE.test(body.hostId || '') || !ROOM_CODE_RE.test(code)) return bad('hostId and code required');
    if (!deps.rooms.restart) return bad('not supported here', 400);
    const out = await deps.rooms.restart(body.hostId, code, body.seed || {});
    if (!out) return bad('That room isn’t one of this TV’s rooms.', 404);
    track(body.hostId, 'room_restarted', { room: code });
    return ok(out);
  }

  // The rooms this TV has made, to switch between.
  if (method === 'POST' && path === '/api/rooms/mine') {
    if (!ID_RE.test(body.hostId || '')) return bad('hostId required');
    const list = await deps.store.roomsForCrew(body.hostId, 12);
    const rooms = await Promise.all(list.map(async (r) => {
      const info = await deps.rooms.info(r.code).catch(() => null);
      return info && { code: r.code, updatedAt: r.updatedAt, players: info.players, phase: info.phase, names: info.names || [] };
    }));
    return ok({ rooms: rooms.filter(Boolean) });
  }

  if (method === 'GET' && (m = path.match(/^\/api\/rooms\/([A-Za-z]{4})$/))) {
    const code = m[1].toUpperCase();
    if (!ROOM_CODE_RE.test(code)) return bad('bad code');
    const info = await deps.rooms.info(code);
    if (!info) return bad('No room with that code. Check the TV!', 404);
    const { connectedIds, names, ...pub } = info;
    return ok(pub);
  }

  if (method === 'POST' && path === '/api/identify') {
    const deviceId = ID_RE.test(body.deviceId || '') ? body.deviceId : null;
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 64) : null;
    // Never suggest someone who is already connected in the room being joined
    // (two identical phones at one party share a fingerprint).
    let exclude = [];
    if (typeof body.room === 'string' && ROOM_CODE_RE.test(body.room.toUpperCase())) {
      exclude = (await deps.rooms.info(body.room.toUpperCase()).catch(() => null))?.connectedIds || [];
    }
    return ok(await identify(store, { deviceId, fingerprint, exclude }));
  }

  if (method === 'GET' && (m = path.match(/^\/api\/profile\/([\w-]{6,64})$/))) {
    const p = await store.getProfile(m[1]);
    if (!p) return bad('not found', 404);
    return ok({ profile: publicProfile(p), best: await store.playerBestAnswers(p.id, 3) });
  }

  if (method === 'GET' && (m = path.match(/^\/api\/crew\/([\w-]{6,64})$/))) {
    const crew = await store.getCrew(m[1]);
    if (!crew) return bad('not found', 404);
    return ok({
      lore: loreSummary(crew.lore, 14),
      hall: await store.hallOfFame(crew.id, 12),
      leaderboard: await store.crewLeaderboard(crew.id, 20),
    });
  }

  // Profile photos: the phone sends a small square JPEG (data URL); we keep it
  // in R2 (or on disk locally) under an unguessable-enough content hash.
  if (method === 'POST' && path === '/api/photo') {
    if (!ID_RE.test(body.deviceId || '')) return bad('deviceId required');
    const m2 = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.image || '');
    if (!m2) return bad('send a JPEG data URL');
    const bin = atob(m2[1]);
    if (bin.length > 400 * 1024) return bad('photo too large', 413);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bad('not a JPEG');
    const file = `${body.deviceId}-${(await sha256Hex(m2[1])).slice(0, 16)}.jpg`;
    await deps.media.put(`photos/${file}`, bytes, 'image/jpeg');
    return ok({ photo: file });
  }

  if (method === 'GET' && (m = path.match(/^\/api\/photo\/([\w.-]+)$/))) {
    if (!PHOTO_RE.test(m[1])) return bad('bad name');
    const bytes = await deps.media.get(`photos/${m[1]}`);
    if (!bytes) return bad('not found', 404);
    return { status: 200, body: bytes, headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } };
  }

  // Reference photos for image games (Picture Duel): same small square JPEG as
  // profile photos, kept under ref/. The game only accepts a ref whose key
  // starts with the sender's own device id.
  if (method === 'POST' && path === '/api/media/ref') {
    if (!ID_RE.test(body.deviceId || '')) return bad('deviceId required');
    const m2 = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.image || '');
    if (!m2) return bad('send a JPEG data URL');
    const bin = atob(m2[1]);
    if (bin.length > 400 * 1024) return bad('photo too large', 413);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bad('not a JPEG');
    const key = `ref/${body.deviceId}-${(await sha256Hex(m2[1])).slice(0, 16)}.jpg`;
    await deps.media.put(key, bytes, 'image/jpeg');
    return ok({ key });
  }

  // Game media (generated images, reference photos). Keys are content- or
  // random-named and never reused, so they cache forever.
  if (method === 'GET' && (m = path.match(/^\/api\/media\/(.+)$/))) {
    if (!MEDIA_KEY_RE.test(m[1])) return bad('bad key');
    const bytes = await deps.media.get(m[1]);
    if (!bytes) return bad('not found', 404);
    const type = EXT_TYPE[m[1].split('.').pop()] || 'application/octet-stream';
    return {
      status: 200, body: bytes,
      headers: {
        'content-type': type, 'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    };
  }

  if (method === 'GET' && path === '/api/tts/status') {
    return ok(await deps.tts.status());
  }

  // GET /api/tts?t=<text>&v=<voice>&s=<tone> is a plain cacheable URL: the TV's
  // browser and (in production) Cloudflare's edge cache keep the audio, so a
  // repeated line costs no synthesis and usually not even an R2 read.
  if ((method === 'GET' || method === 'POST') && path === '/api/tts') {
    const q = req.query || {};
    const text = method === 'GET' ? q.t : body.text;
    const voice = method === 'GET' ? q.v : body.voice;
    const tone = method === 'GET' ? q.s : body.tone;
    const out = await deps.tts.speak(text, { voice, tone }).catch(() => null);
    if (!out) return { status: 204, body: null, headers: { 'cache-control': 'no-store' } };
    return {
      status: 200, body: out.bytes,
      headers: { 'content-type': out.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-tts-provider': out.provider },
    };
  }

  return null;
}
