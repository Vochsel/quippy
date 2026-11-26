// The host's voice-over. Lines are queued and spoken one at a time while the
// music ducks underneath. The server routes each line to a local voice model
// (e.g. Kokoro) or ElevenLabs; if neither answers, the TV browser's own speech
// voices are used. Audio is fetched the moment a line is queued, so it's
// usually ready by the time the previous line finishes.
import { LIVE } from './net.js';

const PREFERRED = [
  // Dry, announcer-ish built-in voices, best first. Australian voices are
  // preferred automatically when the room's locale is en-AU.
  'Lee', 'Gordon', 'Microsoft William', 'Microsoft James', 'Daniel', 'Arthur', 'Google UK English Male',
  'Microsoft Ryan', 'Alex', 'Fred',
];

export class Voice {
  constructor(audio, { provider = 'browser', lang = 'en-AU', onCaption, serverVoices = [], serverVoice = null, now } = {}) {
    this.audio = audio;
    this.now = now || (() => Date.now());
    this.provider = provider; // local | elevenlabs | browser
    this.serverVoices = serverVoices;
    this.serverVoice = localStorage.getItem('quippy.serverVoice') || serverVoice;
    this.lang = lang;
    this.onCaption = onCaption || (() => {});
    this.queue = [];
    this.busy = false;
    this.enabled = localStorage.getItem('quippy.voiceOn') !== '0';
    this.voiceName = localStorage.getItem('quippy.voiceName') || '';
    this.rate = Number(localStorage.getItem('quippy.voiceRate') || 1.1);
    this.playbackRate = Number(localStorage.getItem('quippy.voicePlayback') || 1.12);
    this.pitch = Number(localStorage.getItem('quippy.voicePitch') || 0.85);
    this.voices = [];
    if ('speechSynthesis' in window) {
      const load = () => { this.voices = speechSynthesis.getVoices(); };
      load();
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
  }

  browserVoices() {
    return this.voices.filter((v) => v.lang?.toLowerCase().startsWith('en'));
  }

  pickVoice() {
    const en = this.browserVoices();
    if (this.voiceName) {
      const chosen = en.find((v) => v.name === this.voiceName);
      if (chosen) return chosen;
    }
    const local = en.filter((v) => v.lang?.replace('_', '-').toLowerCase() === this.lang.toLowerCase());
    for (const pool of [local, en]) {
      for (const name of PREFERRED) {
        const hit = pool.find((v) => v.name.includes(name));
        if (hit) return hit;
      }
    }
    return local[0] || en[0] || null;
  }

  setVoice(name) { this.voiceName = name; localStorage.setItem('quippy.voiceName', name); }
  setServerVoice(name) { this.serverVoice = name; localStorage.setItem('quippy.serverVoice', name); }
  usesServer() { return this.provider !== 'browser'; }
  setEnabled(on) { this.enabled = on; localStorage.setItem('quippy.voiceOn', on ? '1' : '0'); if (!on) this.stop(); }

  // ts = when the server said it; scene = which screen it belongs to.
  // Lines from an older screen are dropped as soon as a newer screen speaks,
  // and lines that can't start within a few seconds are skipped, so the
  // voice-over never spills into the next round.
  // opts.onStart / opts.onEnd fire even if the line is skipped or muted.
  say(text, ts = this.now(), opts = {}) {
    if (!text) return;
    const item = { text, ts, scene: opts.scene, cue: opts.cue, onStart: opts.onStart, onEnd: opts.onEnd };
    if (opts.scene && opts.scene !== this.scene) {
      this.scene = opts.scene;
      for (const old of this.queue) { old.onStart?.(); old.onEnd?.(); }
      this.queue = [];
    }
    if (!this.enabled) {
      this.onCaption(text);
      item.onStart?.();
      setTimeout(() => item.onEnd?.(), 1200);
      return;
    }
    // Keep the queue short by dropping chatter, but never read-out lines
    // (cues): the final reads out every answer back to back.
    if (this.queue.length >= 5) {
      const i = this.queue.findIndex((q) => !q.cue);
      if (i >= 0) { const [dropped] = this.queue.splice(i, 1); dropped.onStart?.(); dropped.onEnd?.(); }
    }
    item.audio = this.usesServer() ? this.#fetchAudio(text) : null;
    this.queue.push(item);
    this.#next();
  }

  // Countdown numbers are preloaded and played instantly by the TV itself,
  // locked to its timer ring, so they're never late.
  async preloadCountdown(texts) {
    this.countClips = {};
    if (!this.usesServer()) return;
    await Promise.all(Object.entries(texts || {}).map(async ([n, text]) => {
      const url = await this.#fetchAudio(text);
      if (url) this.countClips[n] = url;
    }));
    this.countTexts = texts;
  }

  countdown(n) {
    if (!this.enabled) return;
    const url = this.countClips?.[n];
    if (url) {
      // Interrupt any chatter: the count matters more.
      this.queue = [];
      this.el?.pause();
      this.endCurrent?.();
      const el = new Audio(url);
      el.playbackRate = 1.1;
      el.play().catch(() => {});
      return;
    }
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(this.countTexts?.[n] || String(n));
      const v = this.pickVoice();
      if (v) u.voice = v;
      u.rate = 1.2;
      speechSynthesis.speak(u);
    }
  }

  // Cut everything off and say this right now.
  sayNow(text) {
    if (!text) return;
    this.onCaption(text);
    if (!this.enabled) return;
    this.queue = [];
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.el?.pause();
    this.endCurrent?.();
    const audio = this.usesServer() ? this.#fetchAudio(text) : null;
    this.audio.duck(true);
    (async () => {
      const url = audio ? await audio : null;
      if (url) await this.#playUrl(url);
      else await this.#speakBrowser(text);
      if (!this.busy) this.audio.duck(false);
    })().catch(() => {});
  }

  stop() {
    this.queue = [];
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.el?.pause();
  }

  async #next() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const item = this.queue.shift();
    try {
      const url = item.audio ? await item.audio : null;
      const stale = item.scene && this.scene && item.scene !== this.scene;
      // Read-out lines (cues) are never skipped for being late: they're the
      // answers. Other chatter is skipped if it's badly behind.
      const late = !item.cue && this.now() - item.ts > (this.queue.length ? 8000 : 12000);
      if (stale || late) {
        if (url) URL.revokeObjectURL(url);
        item.onStart?.();
        return;
      }
      this.onCaption(item.text); // caption appears as the voice starts
      item.onStart?.();
      this.audio.duck(true);
      if (url) await this.#playUrl(url);
      else await this.#speakBrowser(item.text);
    } catch {
      /* keep the show going */
    } finally {
      item.onEnd?.();
      this.audio.duck(false);
      this.busy = false;
      this.#next();
    }
  }

  async #fetchAudio(text) {
    try {
      // A plain GET so the browser (and the edge in production) can cache it.
      const q = new URLSearchParams({ t: text });
      if (this.provider === 'local' && this.serverVoice) q.set('v', this.serverVoice);
      const res = await fetch(`${LIVE}/api/tts?${q}`);
      if (res.status !== 200) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  }

  async #playUrl(url) {
    const el = new Audio(url);
    el.playbackRate = this.playbackRate; // a touch quicker; pitch is preserved
    this.el = el;
    await new Promise((resolve) => {
      this.endCurrent = resolve;
      el.onended = resolve;
      el.onerror = resolve;
      el.play().catch(resolve);
      setTimeout(resolve, 25000);
    });
    this.endCurrent = null;
    URL.revokeObjectURL(url);
  }

  #speakBrowser(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice();
      if (v) u.voice = v;
      u.lang = v?.lang || this.lang;
      u.rate = this.rate;
      u.pitch = this.pitch;
      const done = () => { clearTimeout(guard); resolve(); };
      u.onend = done;
      u.onerror = done;
      // Some browsers never fire onend; don't hang the queue.
      const guard = setTimeout(done, 1500 + text.length * 90);
      speechSynthesis.speak(u);
    });
  }
}
