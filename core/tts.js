// Host voice-over synthesis with a simple router.
//
// Providers are tried in the configured order (default: local, then
// ElevenLabs); the first that's available and succeeds wins. If none do, the
// API answers 204 and the TV falls back to its browser's speech voices.
//
//   local       any OpenAI-style speech server: POST {TTS_LOCAL_URL}/audio/speech
//               {input, voice, speed, response_format}. Kokoro-FastAPI on
//               :8880 is the default. Runs on your machine, free, offline.
//   elevenlabs  ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (a voice you have rights to).
//
// Audio is cached (disk locally, R2 in production) so each unique line is
// synthesised once.
import { sha256Hex } from './util.js';

const ELEVEN_SETTINGS = { stability: 0.38, similarity_boost: 0.8, style: 0.55, use_speaker_boost: true };
const VOICE_RE = /^[\w.-]{1,64}$/;

// Sniff the container so whatever the server returns plays correctly.
export function audioType(bytes) {
  const b = bytes;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'audio/wav';
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67) return 'audio/ogg';
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'audio/flac';
  return 'audio/mpeg';
}

export class Tts {
  constructor(cfg, cache) {
    this.cfg = cfg;
    this.cache = cache;
    this.localState = { checkedAt: 0, up: false, voices: [] };
    this.lastError = null;
    this.lastProvider = null;
  }

  elevenReady() {
    return !!(this.cfg.elevenLabsKey && this.cfg.elevenLabsVoiceId);
  }

  async localUp() {
    const s = this.localState;
    if (Date.now() - s.checkedAt < 30000) return s.up;
    s.checkedAt = Date.now();
    try {
      const res = await fetch(`${this.cfg.localUrl}/voices`, {
        headers: this.#localHeaders(), signal: AbortSignal.timeout(1500),
      });
      s.up = res.ok || res.status === 404; // some servers have no /voices but still speak
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        const list = Array.isArray(body) ? body : body.voices || body.data || [];
        s.voices = list.map((v) => (typeof v === 'string' ? v : v.id || v.name)).filter(Boolean).slice(0, 200);
      }
    } catch {
      s.up = false;
    }
    return s.up;
  }

  #localHeaders() {
    const h = { 'content-type': 'application/json' };
    if (this.cfg.localKey) h.authorization = `Bearer ${this.cfg.localKey}`;
    return h;
  }

  // Which provider would speak right now (for the TV's settings / status).
  async status() {
    for (const p of this.cfg.route) {
      if (p === 'local' && (await this.localUp())) {
        return { provider: 'local', label: 'Local voice model', voice: this.cfg.localVoice, voices: this.localState.voices };
      }
      if (p === 'elevenlabs' && this.elevenReady()) return { provider: 'elevenlabs', label: 'ElevenLabs', voice: null, voices: [] };
    }
    return { provider: 'browser', label: 'Browser voices', voice: null, voices: [] };
  }

  async #cached(key, make) {
    const hit = await this.cache.get(key).catch(() => null);
    if (hit) return hit;
    const bytes = await make();
    await this.cache.put(key, bytes).catch(() => {});
    return bytes;
  }

  async #local(text, voice) {
    const v = VOICE_RE.test(voice || '') ? voice : this.cfg.localVoice;
    const key = `tts/local-${(await sha256Hex(`${this.cfg.localUrl}|${v}|${this.cfg.localSpeed}|${text}`)).slice(0, 40)}`;
    return this.#cached(key, async () => {
      const body = { input: text, voice: v, speed: this.cfg.localSpeed, response_format: 'mp3' };
      if (this.cfg.localModel) body.model = this.cfg.localModel;
      const res = await fetch(`${this.cfg.localUrl}/audio/speech`, {
        method: 'POST', headers: this.#localHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`local voice HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  async #eleven(text) {
    const c = this.cfg;
    const key = `tts/el-${(await sha256Hex(`${c.elevenLabsVoiceId}|${c.elevenLabsModel}|${text}`)).slice(0, 40)}`;
    return this.#cached(key, async () => {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(c.elevenLabsVoiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': c.elevenLabsKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: c.elevenLabsModel, voice_settings: ELEVEN_SETTINGS }),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  // Returns { bytes, type, provider } or null (= let the browser speak).
  async speak(text, { voice } = {}) {
    const clean = String(text || '').trim().slice(0, 500);
    if (!clean) return null;
    for (const p of this.cfg.route) {
      try {
        let bytes = null;
        if (p === 'local' && (await this.localUp())) bytes = await this.#local(clean, voice);
        else if (p === 'elevenlabs' && this.elevenReady()) bytes = await this.#eleven(clean);
        if (bytes?.length) {
          this.lastProvider = p;
          return { bytes, type: audioType(bytes), provider: p };
        }
      } catch (e) {
        this.lastError = `${p}: ${e.message || e}`;
        if (p === 'local') this.localState.checkedAt = 0; // re-probe next time
      }
    }
    return null;
  }
}
