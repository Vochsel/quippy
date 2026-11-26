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

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      const init = await request.json();
      const room = await this.getRoom(init);
      await room.saveNow();
      return Response.json({ ok: true });
    }

    if (url.pathname === '/info') {
      const room = await this.getRoom();
      if (!room) return new Response('not found', { status: 404 });
      const humans = room.publicPlayers().filter((p) => !p.isBot);
      return Response.json({
        code: room.code, players: humans.length, phase: room.game ? 'game' : 'lobby',
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
        close: () => { try { server.close(); } catch { /* closed */ } },
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
