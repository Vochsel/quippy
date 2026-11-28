// The selfie step that picture games open with. The photo becomes the
// player's profile photo (and avatar), and games use it as the reference for
// every picture they paint of that person, so it's taken once, not per round.
//
//   selfieCard({ h, me, action, send, toast, done, onTaken }) -> element
//     me      the player (me.photo = current photo file, if any)
//     action  (a, extra) => live.action(...)  (sends 'selfie')
//     send    (payload) => game action (sends { type: 'selfieDone' })
//     done    true once this player has confirmed for this game
import { api } from './net.js';
import { avatar } from './avatar.js';
import { deviceId } from './identity.js';

// Crop to a centred square and shrink to a JPEG data URL.
export async function squareJpeg(fileObj, size = 512, quality = 0.85) {
  const bmp = await createImageBitmap(fileObj, { imageOrientation: 'from-image' }).catch(() => null);
  const img = bmp || await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('unreadable image'));
    i.src = URL.createObjectURL(fileObj);
  });
  const w = img.width; const hgt = img.height; const side = Math.min(w, hgt);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  c.getContext('2d').drawImage(img, (w - side) / 2, (hgt - side) / 2, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', quality);
}

export function selfieCard({ h, me, action, send, toast = () => {}, done = false, onTaken = () => {} }) {
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'user', style: { display: 'none' } });
  const status = h('p.small.center', '');
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    status.textContent = 'Uploading…';
    try {
      const image = await squareJpeg(f, 512);
      const res = await api('/api/photo', { deviceId: deviceId(), image });
      action('selfie', { photo: res.photo });
      onTaken(res.photo);
      toast('Looking good ✓', 1400);
    } catch (e) {
      status.textContent = `Couldn't use that photo (${e.message}). Try again?`;
    }
    file.value = '';
  });
  const has = !!me?.photo;
  if (done) {
    return h('div.card.center.selfie-card.pop-in',
      avatar(me, '9rem'), h('h2', 'You’re in the picture ✓'), h('p.small', 'Eyes on the TV. The robot is warming up.'));
  }
  return h('div.card.center.selfie-card.pop-in',
    h('h2', has ? 'Use this face?' : 'Selfie time 📸'),
    h('p.small', has
      ? 'The robot paints people from their photo. Keep this one or take a fresh selfie.'
      : 'The robot paints everyone from their selfie. Make it a good one: face the camera, decent light.'),
    has ? avatar(me, '9rem') : h('div.selfie-ghost', '🤳'),
    h('button.btn.pink.block.big', { onClick: () => file.click() }, has ? '📸 Retake selfie' : '📸 Take selfie'),
    has ? h('button.btn.lime.block', { onClick: () => send({ type: 'selfieDone' }) }, '✓ Use this one') : null,
    status, file);
}
