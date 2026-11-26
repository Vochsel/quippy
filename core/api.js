// The small HTTP API, shared by the Node server and the Cloudflare Worker.
// Returns { status, json } or { status, body, headers }, or null if the path
// isn't an API route.
import { GAMES } from '../games/registry.js';
import { identify, publicProfile } from './profiles.js';
import { loreSummary } from './lore.js';
import { synthesize, ttsEnabled } from './tts.js';
import { ROOM_CODE_RE } from './util.js';

const ID_RE = /^[\w-]{6,64}$/;
const ok = (json) => ({ status: 200, json });
const bad = (message, status = 400) => ({ status, json: { error: message } });

// deps: { store, config, llm, content, ttsCache, rooms: { create(hostId), info(code) } }
export async function handleApi(req, deps) {
  const { method, path } = req;
  const body = req.body || {};
  const { store, config, llm, content } = deps;
  let m;

  if (method === 'GET' && path === '/api/config') {
    await llm.init();
    return ok({
      voice: { provider: ttsEnabled(config.voice) ? 'elevenlabs' : 'browser' },
      llm: llm.status(),
      locales: content.locales(),
      defaultLocale: config.defaultLocale,
      speechLang: content.pack(config.defaultLocale).meta.speechLang || 'en-AU',
      games: GAMES.map((g) => ({ id: g.id, name: g.name, tagline: g.tagline, usesAi: !!g.usesAi })),
      publicUrl: config.publicUrl || null,
      dev: config.dev,
    });
  }

  if (method === 'POST' && path === '/api/rooms') {
    if (!ID_RE.test(body.hostId || '')) return bad('hostId required');
    return ok(await deps.rooms.create(body.hostId, { fresh: !!body.fresh }));
  }

  if (method === 'GET' && (m = path.match(/^\/api\/rooms\/([A-Za-z]{4})$/))) {
    const code = m[1].toUpperCase();
    if (!ROOM_CODE_RE.test(code)) return bad('bad code');
    const info = await deps.rooms.info(code);
    if (!info) return bad('No room with that code. Check the TV!', 404);
    const { connectedIds, ...pub } = info;
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

  if (method === 'POST' && path === '/api/tts') {
    if (!ttsEnabled(config.voice)) return { status: 204, body: null };
    try {
      const bytes = await synthesize(config.voice, body.text, deps.ttsCache);
      if (!bytes) return { status: 204, body: null };
      return { status: 200, body: bytes, headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=31536000' } };
    } catch (e) {
      return bad(String(e.message || e), 502);
    }
  }

  return null;
}
