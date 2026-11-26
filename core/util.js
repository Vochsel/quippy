// Small helpers shared by every runtime (no Node or Worker specific APIs).

// Room codes avoid vowels-that-spell-words and look-alike letters.
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  return s;
}
export const ROOM_CODE_RE = /^[A-Z]{4}$/;

export function uid(prefix = '') {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return prefix + [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

// FNV-1a: stable short hash for prompt keys / cache keys.
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function fill(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

export function cleanText(s, max = 80) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function cleanName(s) {
  return cleanText(s, 14).replace(/[<>]/g, '') || 'Mystery Guest';
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, label = 'timeout') {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// Bright, distinguishable player colours (all readable with dark ink).
export const PLAYER_COLORS = [
  '#ff5d8f', '#ffb23f', '#ffe14d', '#7ee081', '#3fd0c9', '#5aa9ff', '#a98bff', '#ff8a5b',
  '#c6f432', '#ff7ad9', '#9ad1ff', '#f4a6a6',
];
export const FACE_COUNT = 8;
