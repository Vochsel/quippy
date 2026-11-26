// AI image generation for games (Picture Duel), plus the free placeholder used
// by bots, tests and rooms without a gateway key.
//
// Runtime-agnostic: the AI SDK is imported lazily (it only does `fetch`), so
// the Node server and the Cloudflare Worker share this file.
import { cleanText } from './util.js';

export class ImageGen {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.gateway = null;
    this.lastError = null;
  }

  available() {
    return this.cfg.provider !== 'none' && !!this.cfg.gatewayKey;
  }

  status() {
    return { available: this.available(), model: this.available() ? this.cfg.model : null };
  }

  // -> { bytes: Uint8Array, type: 'image/jpeg' | 'image/png' | 'image/webp', ms }
  async generate({ prompt, reference = null, signal } = {}) {
    if (!this.available()) throw new Error('image generation is off');
    const [{ generateImage }, { createGateway }] = await Promise.all([import('ai'), import('@ai-sdk/gateway')]);
    this.gateway ||= createGateway({ apiKey: this.cfg.gatewayKey });
    const t = Date.now();
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs || 60000);
    const result = await generateImage({
      model: this.gateway.imageModel(this.cfg.model),
      prompt: reference ? { text: prompt, images: [reference] } : prompt,
      size: this.cfg.size || undefined,
      maxRetries: 1,
      abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const img = result.image;
    return { bytes: img.uint8Array, type: img.mediaType || sniffImage(img.uint8Array), ms: Date.now() - t };
  }
}

export function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  return 'application/octet-stream';
}

// Game media keys: gen/<id>.<ext> (generated) and ref/<deviceId>-<hash>.jpg
// (uploaded reference photos). Strict, so a key can never walk the disk.
export const MEDIA_KEY_RE = /^(gen|ref)\/[\w-]{6,100}\.(jpg|png|webp|svg)$/;

export const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
export const EXT_TYPE = Object.fromEntries(Object.entries(IMAGE_EXT).map(([t, e]) => [e, t]));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function wrap(text, width, maxLines) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) { lines.push(line); line = word; } else line = next;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && lines.join(' ').length < text.length) lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, width - 1)}…`;
  return lines;
}

// A bright "sketch card" with the prompt written on it: what bots draw, and
// what everyone gets when there's no image model.
export function placeholderSvg(prompt, seed = 0) {
  const palette = ['#ff5d8f', '#ffb23f', '#3fd0c9', '#5aa9ff', '#a98bff', '#c6f432', '#ff8a5b', '#7ee081'];
  const a = palette[Math.abs(seed) % palette.length];
  const b = palette[(Math.abs(seed) + 3) % palette.length];
  const text = cleanText(prompt || '…', 160) || '…';
  const lines = wrap(text, 18, 6);
  const size = lines.length > 4 ? 44 : 54;
  const y0 = 384 - ((lines.length - 1) * size * 1.15) / 2;
  const shapes = Array.from({ length: 7 }, (_, i) => {
    const x = (seed * 97 + i * 131) % 700 + 34;
    const y = (seed * 53 + i * 211) % 700 + 34;
    const r = 18 + ((seed + i * 7) % 40);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${i % 2 ? a : b}" opacity=".35"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 768" width="768" height="768">`
    + `<rect width="768" height="768" fill="#fff8ec"/>${shapes}`
    + `<rect x="40" y="40" width="688" height="688" rx="40" fill="none" stroke="#1a0f2e" stroke-width="10" stroke-dasharray="26 18"/>`
    + `<text x="384" y="120" text-anchor="middle" font-family="Arial Rounded MT Bold, Trebuchet MS, sans-serif" font-size="34" fill="#6b5a86">✏️ sketch</text>`
    + lines.map((l, i) => `<text x="384" y="${(y0 + i * size * 1.15).toFixed(0)}" text-anchor="middle" dominant-baseline="middle" font-family="Arial Rounded MT Bold, Trebuchet MS, sans-serif" font-weight="800" font-size="${size}" fill="#1a0f2e">${esc(l)}</text>`).join('')
    + `</svg>`;
}
