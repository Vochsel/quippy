// Cloudflare runtime (production): a Worker for the API plus one Durable Object
// per room holding the live WebSockets and game state.
//
//   D1 (binding DB)        profiles, stats, crews + lore, games, answers, room index
//   R2 (binding MEDIA)     cached host voice-over audio (and future uploads)
//   Durable Object ROOMS   one per room code; snapshots itself so games survive
//                          evictions and deploys
//
// The static site (public/ + game screens) is deployed to Vercel at
// quippy.party and talks to this Worker at QUIPPY_LIVE_URL (e.g.
// https://live.quippy.party). See docs/DEPLOY.md.
import { handleApi } from '../core/api.js';
import { makeRoomCode, ROOM_CODE_RE } from '../core/util.js';
import { workerDeps } from './deps.js';

export { RoomDO } from './room-do.js';

function cors(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] || '';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  };
}

// Which Durable Object hosts a room: restarting a room (keeping its code)
// moves it to a fresh object, "CODE~gen".
async function roomStub(env, store, code) {
  const gen = await store.roomGen(code).catch(() => 0);
  return env.ROOMS.get(env.ROOMS.idFromName(gen ? `${code}~${gen}` : code));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    // WebSocket into a room's Durable Object.
    const ws = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
    if (ws) {
      const code = ws[1].toUpperCase();
      const stub = await roomStub(env, workerDeps(env).store, code);
      const fwd = new Request(`https://room/ws?code=${code}`, request);
      if (env.QUIPPY_VERSION) fwd.headers.set('x-quippy-version', env.QUIPPY_VERSION);
      return stub.fetch(fwd);
    }

    if (url.pathname.startsWith('/api/')) {
      const d = workerDeps(env);
      const ttlMs = d.config.roomTtlHours * 3600 * 1000;
      const rooms = {
        async create(hostId, { fresh } = {}) {
          await d.store.ensureCrew(hostId);
          const since = Date.now() - ttlMs;
          if (!fresh) {
            const existing = await d.store.openRoomForCrew(hostId, since);
            if (existing) return { code: existing, joinUrl: d.joinUrl(existing), resumed: true };
          }
          let code;
          do code = makeRoomCode(); while (await d.store.roomCodeTaken(code));
          await d.store.saveRoom(code, hostId, {});
          const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
          await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, crewId: hostId }) });
          return { code, joinUrl: d.joinUrl(code), resumed: false };
        },
        async reopen(hostId, code) {
          const row = await d.store.getRoom(code);
          if (!row || row.crewId !== hostId) return null;
          const stub = await roomStub(env, d.store, code);
          const res = await stub.fetch('https://room/info');
          if (!res.ok) return null; // no snapshot left
          await d.store.reopenRoom(code);
          return { code, joinUrl: d.joinUrl(code), resumed: true };
        },
        // Same code, fresh room process, seeded from the old room's lobby view.
        async restart(hostId, code, seed) {
          const row = await d.store.getRoom(code);
          if (!row || row.crewId !== hostId) return null;
          const old = await roomStub(env, d.store, code);
          const gen = await d.store.bumpRoomGen(code);
          const stub = env.ROOMS.get(env.ROOMS.idFromName(`${code}~${gen}`));
          await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, crewId: hostId, seed }) });
          // Newer room processes hand their screens over; older ones ignore this.
          ctx.waitUntil(old.fetch('https://room/retire', { method: 'POST' }).catch(() => {}));
          return { code, joinUrl: d.joinUrl(code), restarted: true };
        },
        async info(code) {
          if (!ROOM_CODE_RE.test(code)) return null;
          const row = await d.store.getRoom(code);
          if (!row || row.closed) return null;
          const stub = await roomStub(env, d.store, code);
          const res = await stub.fetch('https://room/info');
          return res.ok ? res.json() : null;
        },
      };
      // Voice lines: answer from Cloudflare's edge cache before touching R2 or a model.
      const ttsGet = request.method === 'GET' && url.pathname === '/api/tts' && url.searchParams.get('t');
      const edge = ttsGet ? caches.default : null;
      if (edge) {
        const hit = await edge.match(request);
        if (hit) return new Response(hit.body, { status: hit.status, headers: { ...Object.fromEntries(hit.headers), ...headers, 'x-tts-cache': 'edge' } });
      }
      let body = {};
      if (request.method === 'POST') body = await request.json().catch(() => ({}));
      try {
        const out = await handleApi(
          { method: request.method, path: url.pathname, body, query: Object.fromEntries(url.searchParams) },
          { ...d, rooms, waitUntil: (p) => ctx.waitUntil(p) });
        if (!out) return Response.json({ error: 'not found' }, { status: 404, headers });
        if (out.json !== undefined) return Response.json(out.json, { status: out.status, headers });
        const res = new Response(out.body, { status: out.status, headers: { ...headers, ...(out.headers || {}) } });
        if (edge && out.status === 200) ctx.waitUntil(edge.put(request, res.clone()));
        return res;
      } catch (e) {
        console.error('api error', e);
        ctx.waitUntil(d.analytics.captureException(null, e, { path: url.pathname, method: request.method }));
        return Response.json({ error: 'server error' }, { status: 500, headers });
      }
    }

    return new Response('Quippy live server. The game is at https://quippy.party', { headers });
  },
};
