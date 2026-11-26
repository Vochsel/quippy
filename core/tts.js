// Host voice-over synthesis. With ElevenLabs configured, lines are rendered
// with your chosen voice and cached (disk locally, R2 in production) so each
// unique line is only paid for once. Without it the TV falls back to the
// browser's built-in speech voices (handled client-side).
import { sha256Hex } from './util.js';

// Expressive, slightly dry delivery: lower stability lets the read wander,
// "style" adds performance. Tune to taste for your voice.
const VOICE_SETTINGS = { stability: 0.38, similarity_boost: 0.8, style: 0.55, use_speaker_boost: true };

export function ttsEnabled(voice) {
  return voice.provider === 'elevenlabs' && !!voice.elevenLabsKey && !!voice.elevenLabsVoiceId;
}

// cache: { get(key) -> Uint8Array|null, put(key, bytes) }
export async function synthesize(voice, text, cache) {
  if (!ttsEnabled(voice)) return null;
  const clean = String(text || '').trim().slice(0, 400);
  if (!clean) return null;
  const key = `tts/${(await sha256Hex(`${voice.elevenLabsVoiceId}|${voice.elevenLabsModel}|${clean}`)).slice(0, 40)}.mp3`;
  const hit = await cache.get(key).catch(() => null);
  if (hit) return hit;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.elevenLabsVoiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': voice.elevenLabsKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: clean, model_id: voice.elevenLabsModel, voice_settings: VOICE_SETTINGS }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await cache.put(key, bytes).catch(() => {});
  return bytes;
}
