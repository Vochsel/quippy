// Original blob characters: 8 body shapes x 8 faces, tinted in the player's colour.
import { h } from './dom.js';

export const COLORS = [
  '#ff5d8f', '#ffb23f', '#ffe14d', '#7ee081', '#3fd0c9', '#5aa9ff', '#a98bff', '#ff8a5b',
  '#c6f432', '#ff7ad9', '#9ad1ff', '#f4a6a6',
];
export const FACES = 8;
const INK = '#1a0f2e';

const BODIES = [
  'M50 6 C78 6 94 26 94 52 C94 80 76 96 50 96 C24 96 6 80 6 52 C6 26 22 6 50 6Z', // blob
  'M18 12 H82 Q92 12 92 22 V84 Q92 94 82 94 H18 Q8 94 8 84 V22 Q8 12 18 12Z', // box
  'M50 4 C80 4 92 30 92 58 V94 L78 84 L64 94 L50 84 L36 94 L22 84 L8 94 V58 C8 30 20 4 50 4Z', // ghost
  'M50 8 L60 20 L76 14 L78 30 L94 36 L86 50 L94 64 L78 70 L76 86 L60 80 L50 94 L40 80 L24 86 L22 70 L6 64 L14 50 L6 36 L22 30 L24 14 L40 20Z', // star burst
  'M50 10 C74 2 98 22 90 50 C98 78 74 98 50 90 C26 98 2 78 10 50 C2 22 26 2 50 10Z', // squish
  'M50 4 C62 4 70 16 70 16 C86 18 96 32 94 52 C92 78 74 96 50 96 C26 96 8 78 6 52 C4 32 14 18 30 16 C30 16 38 4 50 4Z', // bean
  'M14 30 Q14 8 36 8 H64 Q86 8 86 30 V70 Q86 94 50 94 Q14 94 14 70Z', // tall
  'M50 2 C58 14 70 6 74 18 C88 20 96 34 94 50 C96 70 86 92 50 96 C14 92 4 70 6 50 C4 34 12 20 26 18 C30 6 42 14 50 2Z', // flame
];

function face(i) {
  const eye = (cx, cy, r = 7) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="${INK}" stroke-width="3"/><circle cx="${cx + 1.5}" cy="${cy + 1}" r="${r * 0.45}" fill="${INK}"/>`;
  switch (i % FACES) {
    case 0: return `${eye(36, 44)}${eye(64, 44)}<path d="M36 64 Q50 76 64 64" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;
    case 1: return `${eye(35, 42, 10)}${eye(65, 42, 10)}<ellipse cx="50" cy="70" rx="7" ry="9" fill="${INK}"/>`;
    case 2: return `<path d="M28 46 Q36 40 44 46" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><path d="M56 46 Q64 40 72 46" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><path d="M40 68 H60" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;
    case 3: return `${eye(36, 44)}<path d="M58 44 H72" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><path d="M34 62 Q50 82 68 60 Z" fill="${INK}"/><path d="M42 68 Q50 74 58 67" fill="#ff7a9c"/>`;
    case 4: return `<path d="M26 34 L44 40" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><path d="M74 34 L56 40" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>${eye(36, 48, 6)}${eye(64, 48, 6)}<path d="M38 72 Q50 62 62 72" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;
    case 5: return `<path d="M36 36 l3 7 7 1 -5 5 1 7 -6 -3 -6 3 1 -7 -5 -5 7 -1z" fill="${INK}"/><path d="M64 36 l3 7 7 1 -5 5 1 7 -6 -3 -6 3 1 -7 -5 -5 7 -1z" fill="${INK}"/><path d="M32 62 Q50 84 68 62 Z" fill="${INK}"/>`;
    case 6: return `<circle cx="36" cy="46" r="10" fill="#fff" stroke="${INK}" stroke-width="4"/><circle cx="64" cy="46" r="10" fill="#fff" stroke="${INK}" stroke-width="4"/><path d="M46 46 H54" stroke="${INK}" stroke-width="4"/><circle cx="37" cy="47" r="4" fill="${INK}"/><circle cx="65" cy="47" r="4" fill="${INK}"/><path d="M40 68 Q52 74 62 64" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;
    default: return `${eye(34, 42, 11)}${eye(66, 46, 6)}<path d="M38 64 Q50 70 62 64" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><path d="M48 66 Q50 78 56 66" fill="#ff7a9c" stroke="${INK}" stroke-width="2.5"/>`;
  }
}

export function avatarSvg(color = COLORS[0], faceIndex = 0, bodyIndex = faceIndex) {
  const safe = COLORS.includes(color) ? color : '#cccccc';
  const body = BODIES[Math.abs(bodyIndex) % BODIES.length];
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="${body}" transform="translate(4 5)" fill="${INK}"/>
    <path d="${body}" fill="${safe}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
    <ellipse cx="34" cy="24" rx="12" ry="6" fill="#fff" opacity=".35" transform="rotate(-20 34 24)"/>
    ${face(faceIndex)}
  </svg>`;
}

export function avatar(p, size = '3em', opts = {}) {
  const el = h('span.avatar', { style: { width: size, height: size } });
  el.style.setProperty('--s', size);
  el.innerHTML = avatarSvg(p?.color, p?.face ?? 0);
  if (opts.crown) el.append(h('span.crown', '👑'));
  if (opts.className) el.classList.add(...opts.className.split(' '));
  return el;
}
