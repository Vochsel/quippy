// Who is holding this phone? A random device id (localStorage + cookie) is the
// player's profile id. A soft fingerprint lets the server suggest "Welcome
// back, Bazza?" if storage was wiped; the player always confirms.
const KEY = 'quippy.deviceId';

function readCookie(name) {
  return document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.split('=')[1] || null;
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function load(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export const save = store;

function randomId(prefix) {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return prefix + [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 18);
}

export function deviceId() {
  let id = load(KEY) || readCookie('qid');
  if (!id || !/^[\w-]{6,64}$/.test(id)) id = randomId('p_');
  setDeviceId(id);
  return id;
}

export function setDeviceId(id) {
  store(KEY, id);
  document.cookie = `qid=${id}; max-age=${60 * 60 * 24 * 400}; path=/; samesite=lax`;
}

export function hostId() {
  let id = load('quippy.hostId');
  if (!id) { id = randomId('h_'); store('quippy.hostId', id); }
  return id;
}

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function canvasPrint() {
  try {
    const c = document.createElement('canvas');
    c.width = 220; c.height = 40;
    const g = c.getContext('2d');
    g.textBaseline = 'top';
    g.font = "16px 'Arial'";
    g.fillStyle = '#f60'; g.fillRect(100, 1, 62, 20);
    g.fillStyle = '#069'; g.fillText('Quippy 🦘 servo pie', 2, 15);
    g.fillStyle = 'rgba(102,204,0,0.7)'; g.fillText('Quippy 🦘 servo pie', 4, 17);
    return c.toDataURL();
  } catch { return ''; }
}

function webglPrint() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? `${gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)}|${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}` : '';
  } catch { return ''; }
}

export async function fingerprint() {
  if (!crypto.subtle) return null; // non-secure context (plain http on a LAN IP)
  const parts = [
    navigator.userAgent, navigator.language, (navigator.languages || []).join(','), navigator.platform,
    screen.width, screen.height, screen.colorDepth, window.devicePixelRatio,
    Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency, navigator.deviceMemory,
    navigator.maxTouchPoints, canvasPrint(), webglPrint(),
  ];
  return sha(parts.join('||'));
}

// The room this phone was last in: localStorage + a cookie (belt and braces;
// some browsers clear one but not the other).
export function setLastRoom(code) {
  store('quippy.lastRoom', code || '');
  document.cookie = `qroom=${code || ''}; max-age=${code ? 60 * 60 * 12 : 0}; path=/; samesite=lax`;
}
export function lastRoom() {
  const c = load('quippy.lastRoom') || readCookie('qroom') || '';
  return /^[A-Z]{4}$/.test(c) ? c : '';
}
