// One Durable Object per room code. It hosts the room's WebSockets and keeps a
// snapshot in Durable Object storage after every change, so a room resumes
// exactly where it was after an eviction or a deploy.
import { Room } from '../core/room.js';
import { workerDeps } from './deps.js';

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.loading = null;
    this.lastIndexTouch = 0;
  }

  async getRoom(init) {
    if (this.room) return this.room;
    this.loading ||= (async () => {
      const deps = workerDeps(this.env);
      const snapshot = await this.state.storage.get('room');
      const roomDeps = { ...deps, persist: (snap) => this.persist(snap, deps) };
      let room;
      if (snapshot?.code) room = new Room({ code: snapshot.code, crewId: snapshot.crewId, deps: roomDeps, snapshot });
      else if (init) room = new Room({ code: init.code, crewId: init.crewId, deps: roomDeps });
      else return null;
      await room.init();
      this.room = room;
      return room;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async persist(snapshot, deps) {
    await this.state.storage.put('room', snapshot);
    // Keep the D1 room index fresh (so hosts can find their room again), at most once a minute.
    if (Date.now() - this.lastIndexTouch > 60000) {
      this.lastIndexTouch = Date.now();
      await deps.store.touchRoom(snapshot.code).catch(() => {});
    }
  }

  #retire() {
    const room = this.room;
    this.room = null;
    if (room) {
      room.saveNow?.().catch(() => {});
      for (const c of [...(room.conns || [])]) c.close?.(1012, 'room restarted');
    }
    try { this.state.abort?.('retired'); } catch { /* shutting down */ }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      const init = await request.json();
      // A restart: start from the old room's players/scores/settings.
      if (init.seed && !this.room) await this.state.storage.put('room', Room.seedSnapshot(init.code, init.crewId, init.seed));
      const room = await this.getRoom(init);
      await room.saveNow();
      return Response.json({ ok: true });
    }

    // This room moved to a fresh process (or newer code): hang up on every
    // screen so they reconnect to it, then shut down.
    if (url.pathname === '/retire') {
      this.#retire();
      return Response.json({ ok: true });
    }

    // Running older code than the Worker in front of it (a deploy happened while
    // screens were connected): save, hang up, restart on the new code.
    const sent = request.headers.get('x-quippy-version');
    if (sent && this.env.QUIPPY_VERSION && sent !== this.env.QUIPPY_VERSION) {
      this.#retire();
      return new Response('restarting', { status: 503 });
    }

    if (url.pathname === '/info') {
      const room = await this.getRoom();
      if (!room) return new Response('not found', { status: 404 });
      const humans = room.publicPlayers().filter((p) => !p.isBot);
      return Response.json({
        code: room.code, players: humans.length, phase: room.game ? 'game' : 'lobby',
        names: humans.map((p) => p.name).slice(0, 8), // internal; stripped by the API
        connectedIds: humans.filter((p) => p.connected).map((p) => p.id), // internal; stripped by the API
      });
    }

    if (request.headers.get('upgrade') === 'websocket') {
      const room = await this.getRoom();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      if (!room) {
        server.close(4004, 'no such room');
        return new Response(null, { status: 101, webSocket: client });
      }
      const conn = {
        id: crypto.randomUUID(),
        send: (obj) => { try { server.send(JSON.stringify(obj)); } catch { /* closed */ } },
        sendRaw: (str) => { try { server.send(str); } catch { /* closed */ } },
        close: (code, reason) => { try { server.close(code || 1000, reason || ''); } catch { /* closed */ } },
      };
      room.attach(conn);
      server.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
        room.onMessage(conn, msg);
      });
      let gone = false;
      const bye = () => { if (!gone) { gone = true; room.detach(conn); } };
      server.addEventListener('close', bye);
      server.addEventListener('error', bye);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }
}
