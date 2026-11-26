// Picture Duel: TV screens. Reuses the quip sticker styles (quip.css) for the
// shared bits (scoreboard, podium, voter chips) plus its own picture.css.
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
  ensureCss('/games/picture-duel/client/picture.css');
  const { h, avatar, fmt } = api;
  let key = null;
  const keyOf = (g) => [g.phase, g.round, g.matchNo || 0, g.closing ? 'closing' : ''].join('|');
  const onResize = () => fitStage(root);
  addEventListener('resize', onResize);

  const settle = () => fitStage(root);

  function picture(url, cls = '') {
    const img = h(`img.pd-img${cls}`, { src: src(url), alt: '', decoding: 'async' });
    img.addEventListener('load', () => { img.classList.add('loaded'); settle(); });
    return img;
  }

  function brief(g, animate = true) {
    return h(`div.card.pd-brief${animate ? '.pop-in' : ''}`, h('span.pd-brief-label', 'The brief'), h('div.pd-brief-text', g.prompt));
  }

  function voterChip(v, delay) {
    return h('span.q-chip', { style: { animationDelay: `${delay}s`, '--c': v.color } }, avatar(v, '1.9rem'), h('span', v.name));
  }

  function voterRow(voters = []) {
    return h('div.q-voter-row', voters.map((v) => h(`span.q-vwait${v.done ? '.done' : ''}`, { 'data-id': v.id },
      avatar(v, '2.6rem'), h('span', v.name), h('i', '✓'))));
  }

  const screens = {
    intro(g) {
      return h('div.q-intro',
        h('h1.q-title.slam', g.title),
        h('p.q-tagline.slide-up', g.tagline),
        h('div.q-steps',
          [['✍️', 'Write an image prompt on your phone'], ['🎨', 'The robot paints it (3 tries)'], ['🗳️', 'The room picks the better picture']]
            .map(([icon, text], i) => h('div.card.q-step.pop-in', { style: { animationDelay: `${0.3 + i * 0.25}s` } },
              h('div.q-step-icon', icon), h('div', text)))),
        g.ai ? null : h('p.pd-note.slide-up', 'No image model connected, so tonight the robot only does sketches.'));
    },

    loading(g) {
      return h('div.q-loading',
        h('div.q-round-card.slam', g.roundTitle || `Round ${g.round}`),
        g.round === 2 ? h('div.chip.pink.q-double.pop-in', 'Double points!') : null,
        h('p.q-loading-text', h('span.spinner'), ' ', g.text || 'Handing out the briefs…'));
    },

    create(g) {
      if (g.closing) {
        return h('div.q-loading',
          h('div.q-round-card.slam', 'Brushes down!'),
          h('p.q-loading-text', h('span.spinner'), ' A few masterpieces are still drying…'));
      }
      return h('div.pd-create',
        h('h2.q-heading.slide-up', g.roundTitle || `Round ${g.round}`),
        h('p.q-big.pop-in', 'Make your picture on your phone!'),
        h('div.q-done-grid', g.players.map((p) => h(`div.q-done.pd-artist${p.done ? '.yes' : ''}${p.painting ? '.painting' : ''}`, { 'data-id': p.id },
          avatar(p, '6rem'), h('div.nm', p.name), h('div.tick', '✓'), h('div.pd-brush', '🎨'),
          h('div.pd-dots', Array.from({ length: p.maxTries || 3 }, (_, i) => h(`i${i < p.tries ? '.on' : ''}`)))))));
    },

    vote(g) {
      return h('div.pd-vote',
        h('div.q-meta', `${g.roundTitle || `Round ${g.round}`} · duel ${g.matchNo} of ${g.matchTotal}`),
        brief(g),
        h('div.pd-versus',
          g.images.map((im, i) => h(`div.card.pd-frame.pop-in${i ? '.tilt-r' : '.tilt-l'}`, { style: { animationDelay: `${0.3 + i * 0.35}s` } },
            h('span.q-letter', im.key), picture(im.url))),
          h('div.pd-vs', 'VS')),
        voterRow(g.voters),
        h('div.q-progress', 'Vote on your phone!'));
    },

    reveal(g) {
      const banner = { forfeit: 'WIN BY FORFEIT', tie: 'IT’S A TIE', noVotes: 'NOBODY VOTED', noContest: 'NO CONTEST' }[g.kind];
      const T = { voters: 0.5, pct: 1.6, author: 2.4, result: 3.2 };
      const decided = g.answers.some((a) => a.winner);
      return h('div.pd-vote.pd-reveal',
        h('div.q-meta', `${g.roundTitle || `Round ${g.round}`} · duel ${g.matchNo} of ${g.matchTotal}`),
        brief(g, false),
        h('div.pd-versus',
          g.answers.map((a, i) => h(`div.card.pd-frame.q-res${a.winner ? '.win' : decided ? '.lose' : ''}`, { style: { '--c': a.author.color, '--result-delay': `${T.result}s` } },
            a.winner ? h('div.q-ribbon', { style: { animationDelay: `${T.result}s` } }, g.kind === 'shutout' ? 'SHUTOUT!' : 'WINNER') : null,
            a.url ? picture(a.url, '.small') : h('div.pd-empty', 'No picture'),
            a.imagePrompt ? h('p.pd-said', { style: { animationDelay: `${T.author + i * 0.25}s` } }, `“${a.imagePrompt}”`, a.usedRef ? h('span.chip.teal.pd-ref', '📷 + photo') : null) : null,
            h('div.q-tally',
              h('div.q-pct', { style: { animationDelay: `${T.pct}s` } }, `${a.pct}%`),
              h('div.q-meter', h('div.q-meter-fill', { style: { width: `${a.pct}%`, animationDelay: `${T.pct}s` } }))),
            h('div.q-voter-chips', a.voters.length ? a.voters.map((v, j) => voterChip(v, T.voters + j * 0.18))
              : h('span.q-novotes', { style: { animationDelay: `${T.voters}s` } }, 'no votes')),
            h('div.q-byline', { style: { animationDelay: `${T.author + i * 0.25}s` } },
              h('span.q-by', 'by'), avatar(a.author, '2.6rem'), h('b', a.author.name)),
            h('div.q-points', { style: { animationDelay: `${T.result + 0.3}s` } }, `+${fmt(a.points)}`)))),
        banner ? h('div.q-banner.slam', { style: { animationDelay: `${T.result}s` } }, banner) : null);
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
      return h('div.q-scores', h('h2.q-heading.slide-up', 'Scores'), board);
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

  function shutoutShow() {
    setTimeout(() => api.audio?.sfx?.('shutoutBig'), 2700);
    setTimeout(() => {
      const card = root.querySelector('.q-res.win');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.classList.add('shutout-hit');
      api.confetti?.({ count: 160, duration: 2600, origin: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, spread: true });
    }, 3200);
  }

  function patch(g) {
    if (g.phase === 'create') {
      for (const p of g.players || []) {
        const el = root.querySelector(`.pd-artist[data-id="${p.id}"]`);
        if (!el) continue;
        el.classList.toggle('yes', !!p.done);
        el.classList.toggle('painting', !!p.painting);
        el.querySelectorAll('.pd-dots i').forEach((d, i) => d.classList.toggle('on', i < p.tries));
      }
    }
    if (g.phase === 'vote') {
      for (const v of g.voters || []) root.querySelector(`.q-vwait[data-id="${v.id}"]`)?.classList.toggle('done', !!v.done);
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
        if (g.phase === 'reveal' && g.kind === 'shutout') shutoutShow();
      } else {
        patch(g);
      }
    },
    destroy() { removeEventListener('resize', onResize); },
  };
}
