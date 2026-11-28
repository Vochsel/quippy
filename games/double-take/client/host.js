// Double Take: TV screens. Reuses the quip sticker styles (quip.css) for the
// shared bits (scoreboard, podium, ticks) plus its own double-take.css.
// mount(root, api) -> { update(gameView, roomView), destroy() }
import { mountInto } from '/js/lib/dom.js';
import { LIVE } from '/js/lib/net.js';

function ensureCss(href) {
  if (!document.querySelector(`link[href="${href}"]`)) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
  }
}

const src = (url) => (url ? LIVE + url : '');

function countUp(el, from, to, ms) {
  const start = performance.now();
  const fmtN = (n) => Number(n).toLocaleString('en-AU');
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = fmtN(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// TVs can't scroll: if a screen is taller than the stage, scale it down to fit.
function fitStage(root) {
  const el = root.firstElementChild;
  if (!el) return;
  el.style.zoom = '';
  const avail = root.clientHeight - parseFloat(getComputedStyle(root).paddingBottom || 0);
  const need = el.scrollHeight;
  if (need > avail + 2) el.style.zoom = String(Math.max(0.5, Math.floor((avail / need) * 100) / 100));
}

export function mount(root, api) {
  ensureCss('/games/_quip/client/quip.css');
  ensureCss('/games/double-take/client/double-take.css');
  const { h, avatar, fmt } = api;
  let key = null;
  const keyOf = (g) => [g.phase, g.picNo,
    g.phase === 'selfie' ? (g.players || []).map((p) => `${p.id}:${p.photo || ''}`).join(',') : ''].join('|');
  const settle = () => fitStage(root);
  addEventListener('resize', settle);

  function picture(url) {
    const img = h('img.dt-img', { src: src(url), alt: '', decoding: 'async' });
    img.addEventListener('load', () => { img.classList.add('loaded'); settle(); });
    return img;
  }

  const picMeta = (g) => h('div.q-meta', `Picture ${g.picNo} of ${g.picTotal}${g.mult > 1 ? ' · double points' : ''}`);

  function tickGrid(people, cls = '6rem') {
    return h('div.q-done-grid', people.map((p) => h(`div.q-done${p.done ? '.yes' : ''}`, { 'data-id': p.id },
      avatar(p, cls), h('div.nm', p.name), h('div.tick', '✓'))));
  }

  function progressDots(g) {
    return h('div.dt-dots', Array.from({ length: g.total || 0 }, (_, i) => h(`i${i < g.done ? '.on' : ''}`)));
  }

  const paintLabel = (g) => (g.sketchOnly ? `Sketching… ${g.done}/${g.total}` : `The robot is painting… ${g.done}/${g.total}`);

  const screens = {
    intro(g) {
      return h('div.q-intro',
        h('h1.q-title.slam', g.title),
        h('p.q-tagline.slide-up', g.tagline),
        h('div.q-steps',
          [['🤳', 'Take a selfie'], ['✍️', 'Secretly write a picture starring someone here'], ['🔎', 'Spot which caption really made each picture']]
            .map(([icon, text], i) => h('div.card.q-step.pop-in', { style: { animationDelay: `${0.3 + i * 0.25}s` } },
              h('div.q-step-icon', icon), h('div', text)))),
        g.ai ? null : h('p.dt-note.slide-up', 'No image model connected, so tonight you get redacted sketches. Still counts.'));
    },

    selfie(g) {
      return h('div.dt-selfie',
        h('h2.q-heading.slide-up', 'Selfie time 📸'),
        h('p.q-big.pop-in', 'Take a selfie on your phone (or keep yours). The robot paints you from it.'),
        tickGrid(g.players, '7rem'));
    },

    write(g) {
      return h('div.dt-selfie',
        h('h2.q-heading.slide-up', 'Write a secret picture ✍️'),
        h('p.q-big.pop-in', 'Star someone in the room: yourself, your mate, anyone. Keep it secret.'),
        tickGrid(g.players, '7rem'));
    },

    painting(g) {
      return h('div.q-loading',
        h('div.q-round-card.slam', `Picture ${g.picNo} of ${g.picTotal}`),
        g.mult > 1 ? h('div.chip.pink.q-double.pop-in', 'Double points!') : null,
        h('p.q-loading-text.dt-progress', h('span.spinner'), ' ', h('span.dt-progress-text', paintLabel(g))),
        progressDots(g));
    },

    guess(g) {
      return h('div.dt-guess',
        picMeta(g),
        h('div.dt-stage',
          h('div.card.dt-frame.tilt-l.pop-in', picture(g.image)),
          h('div.dt-captions', g.captions.map((c, i) => h('div.card.dt-cap.pop-in', { style: { animationDelay: `${0.6 + i * 0.15}s` } },
            h('span.dt-cap-n', `${i + 1}`), h('span.dt-cap-text', c))))),
        h('div.q-voter-row', g.guessers.map((v) => h(`span.q-vwait${v.done ? '.done' : ''}`, { 'data-id': v.id },
          avatar(v, '2.6rem'), h('span', v.name), h('i', '✓')))),
        h('div.q-progress', 'Which caption made this? Pick on your phone!'));
    },

    reveal(g) {
      const T = { caption: 0.5, pickers: 1.3, byline: 2.2, results: 3 };
      return h('div.dt-guess.dt-reveal',
        picMeta(g),
        h('div.dt-stage',
          h('div.card.dt-frame',
            picture(g.image),
            h('div.dt-byline', { style: { animationDelay: `${T.byline}s` } }, avatar(g.author, '2.6rem'), h('span', 'Written by '), h('b', g.author.name))),
          h('div.dt-captions', g.captions.map((c, i) => h(`div.card.dt-cap${c.real ? '.real' : '.decoy'}`, { style: { '--d': `${T.caption}s` } },
            h('span.dt-cap-n', c.real ? '✓' : '✗'), h('span.dt-cap-text', c.text),
            h('div.dt-pickers', c.pickers.map((p, j) => h('span.dt-picker', { style: { animationDelay: `${T.pickers + i * 0.1 + j * 0.08}s` } }, avatar(p, '1.8rem')))))))),
        h('div.dt-results', g.results.map((r, i) => h(`div.dt-res${r.right || (r.author && r.points) ? '.r1' : '.r0'}`, { style: { animationDelay: `${T.results + i * 0.08}s` } },
          avatar(r, '3rem'), h('b', r.name),
          h('span.dt-res-n', r.author ? `✍️ ${g.spotted}/${g.guessed}` : r.right ? '✓' : r.picked ? '✗' : '—'),
          h('span.dt-res-pts', r.points ? `+${fmt(r.points)}` : '')))));
    },

    scores(g) {
      const ROW = 5.2;
      const rows = g.scoreboard.map((p) => ({ ...p, prev: p.score - (p.delta || 0) }));
      const before = [...rows].sort((a, b) => b.prev - a.prev);
      const max = Math.max(1, ...rows.map((p) => p.score));
      const board = h('div.q-board.anim', { style: { height: `${rows.length * ROW}rem` } });
      const els = new Map();
      before.forEach((p, i) => {
        const score = h('span.q-score', fmt(p.prev));
        const fill = h('div.q-fill', { style: { width: `${(p.prev / max) * 100}%`, background: p.color } });
        const rank = h('span.q-rank', `${i + 1}`);
        const el = h('div.q-row', { style: { top: `${i * ROW}rem` } },
          rank, avatar(p, '3.6rem'), h('span.q-name', p.name), h('div.q-bar', fill), score,
          p.delta ? h('span.q-delta', `+${fmt(p.delta)}`) : h('span.q-delta'));
        els.set(p.id, { el, score, fill, rank, p });
        board.append(el);
      });
      setTimeout(() => {
        for (const { el, score, fill, p } of els.values()) {
          if (p.delta) el.classList.add('gaining');
          fill.style.width = `${(p.score / max) * 100}%`;
          countUp(score, p.prev, p.score, 1100);
        }
      }, 1000);
      setTimeout(() => {
        g.scoreboard.forEach((p, i) => {
          const r = els.get(p.id);
          if (before.findIndex((x) => x.id === p.id) - i > 0) r.el.classList.add('up');
          r.el.style.top = `${i * ROW}rem`;
          r.rank.textContent = `${p.rank}`;
        });
      }, 2300);
      return h('div.q-scores', h('h2.q-heading.slide-up', g.final ? 'Final scores' : 'Halfway scores'), board);
    },

    gameOver(g) {
      const top = g.scoreboard.filter((p) => p.rank <= 3);
      const order = [top.find((p) => p.rank === 2), top.find((p) => p.rank === 1), top.find((p) => p.rank === 3)].filter(Boolean);
      const room = api.room();
      return h('div.q-over',
        h('h2.q-heading.slam', g.scoreboard[0] ? `${g.scoreboard.filter((p) => p.rank === 1).map((p) => p.name).join(' & ')} wins!` : 'Game over'),
        h('div.q-podium', order.map((p) => h(`div.q-pod.r${p.rank}.slide-up`, { style: { animationDelay: `${(3 - p.rank) * 0.4}s` } },
          avatar(p, p.rank === 1 ? '9rem' : '6.5rem', { crown: p.rank === 1, mood: p.rank === 1 ? 'cheer' : p.rank === 3 ? 'happy' : '' }),
          h('b', p.name), h('span', fmt(p.score)), h('div.q-block', `#${p.rank}`)))),
        g.awards?.length ? h('div.q-awards', g.awards.map((a, i) => h('div.card.q-award.pop-in', { style: { animationDelay: `${1.5 + i * 0.3}s` } },
          h('small', a.title), h('b', a.name)))) : null,
        api.isOwner() ? h('button.btn.teal.q-continue', { onClick: () => api.action('continue') }, 'Back to lobby ▶')
          : h('p.small', `Back to the lobby shortly${room?.vipId ? ' (or when the VIP taps continue)' : ''}.`));
    },
  };

  function patch(g) {
    if (g.phase === 'selfie' || g.phase === 'write') {
      for (const p of g.players || []) root.querySelector(`.q-done[data-id="${p.id}"]`)?.classList.toggle('yes', !!p.done);
    }
    if (g.phase === 'painting') {
      const t = root.querySelector('.dt-progress-text');
      if (t) t.textContent = paintLabel(g);
      root.querySelectorAll('.dt-dots i').forEach((d, i) => d.classList.toggle('on', i < g.done));
    }
    if (g.phase === 'guess') {
      for (const v of g.guessers || []) root.querySelector(`.q-vwait[data-id="${v.id}"]`)?.classList.toggle('done', !!v.done);
    }
  }

  return {
    update(g) {
      if (!g) return;
      const k = keyOf(g);
      if (k !== key) {
        key = k;
        const fn = screens[g.phase];
        mountInto(root, fn ? fn(g) : h('div'));
        requestAnimationFrame(settle);
        setTimeout(settle, 700);
        setTimeout(settle, 1800);
        if (g.phase === 'reveal' && g.spotted === 0 && g.results?.some((r) => r.picked && !r.author)) setTimeout(() => api.confetti?.({ count: 70, duration: 1600 }), 2400);
      } else {
        patch(g);
      }
    },
    destroy() { removeEventListener('resize', settle); },
  };
}
