// Canvas confetti burst for winners.
const COLORS = ['#ff5d8f', '#ffb23f', '#ffe14d', '#3fd0c9', '#5aa9ff', '#a98bff', '#c6f432'];

export function confetti({ count = 180, duration = 4500 } = {}) {
  const c = document.createElement('canvas');
  Object.assign(c.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 50 });
  document.body.append(c);
  const g = c.getContext('2d');
  const resize = () => { c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio; };
  resize();
  const W = () => c.width;
  const H = () => c.height;
  const bits = Array.from({ length: count }, () => ({
    x: W() / 2 + (Math.random() - 0.5) * W() * 0.3,
    y: H() * 0.55,
    vx: (Math.random() - 0.5) * 26 * devicePixelRatio,
    vy: (-Math.random() * 28 - 12) * devicePixelRatio,
    r: (6 + Math.random() * 8) * devicePixelRatio,
    rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    shape: Math.random() < 0.5 ? 'rect' : 'circle',
  }));
  const start = performance.now();
  const frame = (now) => {
    const t = now - start;
    g.clearRect(0, 0, W(), H());
    for (const b of bits) {
      b.vy += 0.9 * devicePixelRatio;
      b.vx *= 0.99;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.rot);
      g.globalAlpha = Math.max(0, 1 - t / duration);
      g.fillStyle = b.color;
      if (b.shape === 'rect') g.fillRect(-b.r / 2, -b.r / 3, b.r, b.r / 1.6);
      else { g.beginPath(); g.arc(0, 0, b.r / 2.2, 0, Math.PI * 2); g.fill(); }
      g.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else c.remove();
  };
  requestAnimationFrame(frame);
}
