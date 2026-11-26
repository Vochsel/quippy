// Talking to the live server: plain HTTP for the API, a self-healing WebSocket
// for the room. On Vercel the site and the live server are on different
// origins; env.js tells us where the live server is (blank = same origin).
export const LIVE = String(window.QUIPPY?.live || '').replace(/\/+$/, '');

export async function api(path, body) {
  const res = await fetch(LIVE + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

export class LiveRoom {
  constructor(code, { hello, onMessage, onStatus }) {
    this.code = code;
    this.hello = hello; // () => hello message, sent on every (re)connect
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.offset = 0;
    this.backoff = 500;
    this.closedForGood = false;
    this.ws = null;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.isOpen()) this.connect();
    });
    window.addEventListener('online', () => !this.isOpen() && this.connect());
    // Clock sync: ping/pong round trips; trust the fastest recent samples.
    this.samples = [];
    this.pings = new Map();
    setInterval(() => this.ping(), 15000);
  }

  url() {
    const base = LIVE || location.origin;
    return `${base.replace(/^http/, 'ws')}/ws/${this.code}`;
  }

  isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect() {
    if (this.closedForGood) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(this.retry);
    this.onStatus('connecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.onStatus('open');
      ws.send(JSON.stringify(this.hello()));
      for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 250);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'pong') { this.#pong(msg); return; }
      // Until the first ping returns, use the server's clock as a rough guide.
      if (!this.samples.length && typeof msg.now === 'number') this.offset = msg.now - Date.now();
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      if (ev.code === 4004) {
        this.closedForGood = true;
        this.onStatus('gone');
        return;
      }
      this.onStatus('closed');
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
  }

  ping() {
    if (!this.isOpen()) return;
    const id = Math.random().toString(36).slice(2, 9);
    this.pings.set(id, performance.now());
    this.send({ t: 'ping', id });
  }

  #pong(msg) {
    const sent = this.pings.get(msg.id);
    if (sent === undefined || typeof msg.now !== 'number') return;
    this.pings.delete(msg.id);
    const rtt = performance.now() - sent;
    // Server stamped `now` about halfway through the round trip.
    this.samples.push({ rtt, offset: msg.now + rtt / 2 - Date.now() });
    if (this.samples.length > 12) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    this.offset = best.reduce((x, b) => x + b.offset, 0) / best.length;
    this.rtt = best[0].rtt;
  }

  send(obj) {
    if (this.isOpen()) this.ws.send(JSON.stringify(obj));
  }

  action(a, extra = {}) { this.send({ t: 'action', a, ...extra }); }
  game(payload) { this.action('game', { payload }); }
  serverNow() { return Date.now() + this.offset; }

  close() {
    this.closedForGood = true;
    this.ws?.close();
  }
}
