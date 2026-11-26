// The host's voice-over. Lines are queued and spoken one at a time while the
// music ducks underneath. With ElevenLabs configured on the server, lines are
// rendered in your chosen voice; otherwise the TV browser's own speech voices
// are used (pick one in the lobby's ⚙️ settings).
import { LIVE } from './net.js';

const PREFERRED = [
  // Dry, announcer-ish built-in voices, best first. Australian voices are
  // preferred automatically when the room's locale is en-AU.
  'Lee', 'Gordon', 'Microsoft William', 'Microsoft James', 'Daniel', 'Arthur', 'Google UK English Male',
  'Microsoft Ryan', 'Alex', 'Fred',
];

export class Voice {
  constructor(audio, { provider = 'browser', lang = 'en-AU', onCaption } = {}) {
    this.audio = audio;
    this.provider = provider;
    this.lang = lang;
    this.onCaption = onCaption || (() => {});
    this.queue = [];
    this.busy = false;
    this.enabled = localStorage.getItem('quippy.voiceOn') !== '0';
    this.voiceName = localStorage.getItem('quippy.voiceName') || '';
    this.rate = Number(localStorage.getItem('quippy.voiceRate') || 1.02);
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
  setEnabled(on) { this.enabled = on; localStorage.setItem('quippy.voiceOn', on ? '1' : '0'); if (!on) this.stop(); }

  say(text) {
    if (!text) return;
    this.onCaption(text);
    if (!this.enabled) return;
    // Don't let a backlog build up: the room moves fast.
    if (this.queue.length >= 3) this.queue.shift();
    this.queue.push(text);
    this.#next();
  }

  stop() {
    this.queue = [];
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.el?.pause();
  }

  async #next() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const text = this.queue.shift();
    this.audio.duck(true);
    try {
      if (this.provider === 'elevenlabs') {
        const ok = await this.#playServer(text);
        if (!ok) await this.#speakBrowser(text);
      } else {
        await this.#speakBrowser(text);
      }
    } catch {
      /* keep the show going */
    } finally {
      this.audio.duck(false);
      this.busy = false;
      this.#next();
    }
  }

  async #playServer(text) {
    try {
      const res = await fetch(`${LIVE}/api/tts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
      });
      if (res.status !== 200) return false;
      const url = URL.createObjectURL(await res.blob());
      const el = new Audio(url);
      this.el = el;
      await new Promise((resolve) => {
        el.onended = resolve;
        el.onerror = resolve;
        el.play().catch(resolve);
        setTimeout(resolve, 20000);
      });
      URL.revokeObjectURL(url);
      return true;
    } catch {
      return false;
    }
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
