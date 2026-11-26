// TV screens for quip-style games (Zinger Duel, Callback Club).
// mount(root, api) -> { update(gameView, roomView), destroy() }
import { mountInto } from '/js/lib/dom.js';

function ensureCss(href) {
  if (!document.querySelector(`link[href="${href}"]`)) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
  }
}

// Long answers: shrink by length, then (if still too tall) scroll slowly up and
// down inside their card so every word gets read.
function fitText(text) {
  const t = String(text ?? '');
  const size = t.length > 150 ? 'len-xl' : t.length > 100 ? 'len-l' : t.length > 55 ? 'len-m' : 'len-s';
  const inner = document.createElement('div');
  inner.className = 'fit-inner';
  inner.textContent = t;
  const box = document.createElement('div');
  box.className = `fit ${size}`;
  box.append(inner);
  return box;
}

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

function autoScroll(root) {
  for (const box of root.querySelectorAll('.fit')) {
    const inner = box.firstElementChild;
    const overflow = inner.scrollHeight - box.clientHeight;
    box.classList.toggle('scrolling', overflow > 4);
    if (overflow > 4) {
      box.style.setProperty('--scroll', `${-overflow}px`);
      box.style.setProperty('--dur', `${Math.max(5, overflow / 18)}s`);
    }
  }
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
  const { h, avatar, fmt } = api;
  let key = null;

  const keyOf = (g) => [g.phase, g.round, g.matchNo || 0, g.closed ? 'closed' : ''].join('|');

  const onResize = () => fitStage(root);
  addEventListener('resize', onResize);
  const flip = (key) => root.querySelector(`.q-ans[data-ans="${key}"]`)?.classList.remove('face-down');
  const offCue = api.onCue?.((cue) => { if (cue === 'A' || cue === 'B') flip(cue); });

  function promptCard(g, animate = true) {
    return h(`div.card.q-prompt${animate ? '.pop-in' : ''}`,
      h('div.q-prompt-text', g.prompt),
      g.callback ? h('span.chip.teal.q-callback', `↩ callback: ${g.callback}`) : null);
  }

  function playersDone(players) {
    return h('div.q-done-grid', players.map((p) => h(`div.q-done${p.done ? '.yes' : ''}`, { 'data-id': p.id },
      avatar(p, '6rem'), h('div.nm', p.name), h('div.tick', '✓'))));
  }

  const screens = {
    intro(g) {
      const extra = g.extra;
      return h('div.q-intro',
        h('h1.q-title.slam', g.title),
        h('p.q-tagline.slide-up', g.tagline),
        h('div.q-steps',
          [['✍️', 'Answer prompts on your phone'], ['🗳️', 'Vote for the funnier answer'], ['🏆', 'Most points wins']]
            .map(([icon, text], i) => h('div.card.q-step.pop-in', { style: { animationDelay: `${0.3 + i * 0.25}s` } },
              h('div.q-step-icon', icon), h('div', text)))),
        extra ? h('div.card.q-lore.slide-up', { style: { animationDelay: '1.2s' } },
          h('h3', '📖 From the Lore Book'),
          extra.jokes?.length
            ? h('ul', extra.jokes.map((j) => h('li', h('b', j.title), j.detail ? h('small', ` — ${j.detail}`) : null)))
            : h('p', 'Nothing yet. Tonight we start writing it.')) : null);
    },

    loading(g) {
      return h('div.q-loading',
        h('div.q-round-card.slam', g.roundTitle || `Round ${g.round}`),
        g.round === 2 ? h('div.chip.pink.q-double.pop-in', 'Double points!') : null,
        h('p.q-loading-text', h('span.spinner'), ' ', g.text || 'Shuffling the prompts…'));
    },

    answer(g) {
      if (g.closed) {
        return h('div.q-loading',
          h('div.q-round-card.slam', 'Answers locked!'),
          h('p.q-loading-text', h('span.spinner'), ' Get your thumbs ready to vote…'));
      }
      return h('div.q-answer',
        h('h2.q-heading.slide-up', g.roundTitle || `Round ${g.round}`),
        h('p.q-big.pop-in', 'Answer the prompts on your phone!'),
        playersDone(g.players));
    },

    finalAnswer(g) {
      return h('div.q-answer',
        h('h2.q-heading.slide-up', g.roundTitle || 'Final round'),
        promptCard(g),
        h('p.q-sub', 'Everyone answers this one.'),
        playersDone(g.players));
    },

    // While Monty reads them out, answers stay face-down and flip up as he
    // says each one (cues from the voice queue). Then voting opens.
    vote(g) {
      const hidden = g.reading ? '.face-down' : '';
      return h(`div.q-vote${g.reading ? '.reading' : ''}`,
        h('div.q-meta', `${g.roundTitle || `Round ${g.round}`} · matchup ${g.matchNo} of ${g.matchTotal}`),
        promptCard(g),
        h('div.q-versus',
          g.answers.map((a, i) => h(`div.card.q-ans${hidden}${i ? '.tilt-r' : '.tilt-l'}`, { 'data-ans': a.key },
            h('span.q-letter', a.key), h('div.q-ans-text', fitText(a.text)), h('div.q-ans-back', '?'))),
          h('div.q-vs', 'VS')),
        voterRow(g.voters),
        h('div.q-progress', { 'data-live': 'vote-hint' }, g.reading ? 'Listen up…' : 'Vote on your phone!'));
    },

    reveal(g) {
      // Sequence: voters land under each answer -> percentages -> who wrote it -> winner + points.
      const banner = { forfeit: 'WIN BY FORFEIT', tie: 'IT’S A TIE', noVotes: 'NOBODY VOTED', noContest: 'NO CONTEST' }[g.kind];
      const T = { voters: 0.5, pct: 1.7, author: 2.4, result: 3.1 };
      const decided = g.answers.some((a) => a.winner);
      return h('div.q-vote.q-reveal',
        h('div.q-meta', `${g.roundTitle || `Round ${g.round}`} · matchup ${g.matchNo} of ${g.matchTotal}`),
        promptCard(g, false),
        h('div.q-versus',
          g.answers.map((a, i) => h(`div.card.q-ans.q-res${a.winner ? '.win' : decided ? '.lose' : ''}`, { style: { '--c': a.author.color, '--result-delay': `${T.result}s` } },
            a.winner ? h('div.q-ribbon', { style: { animationDelay: `${T.result}s` } }, g.kind === 'shutout' ? 'SHUTOUT!' : 'WINNER') : null,
            h('div.q-ans-text', fitText(a.text || '(no answer)')),
            h('div.q-tally',
              h('div.q-pct', { style: { animationDelay: `${T.pct}s` } }, `${a.pct}%`),
              h('div.q-meter', h('div.q-meter-fill', { style: { width: `${a.pct}%`, animationDelay: `${T.pct}s` } }))),
            h('div.q-voter-chips', a.voters.length
              ? a.voters.map((v, j) => voterChip(v, T.voters + j * 0.18))
              : h('span.q-novotes', { style: { animationDelay: `${T.voters}s` } }, 'no votes')),
            h('div.q-byline', { style: { animationDelay: `${T.author + i * 0.25}s` } },
              h('span.q-by', 'by'), avatar(a.author, '2.8rem'), h('b', a.author.name),
              a.panic ? h('span.chip.pink.q-panic', '🆘 panic') : null),
            h('div.q-points', { style: { animationDelay: `${T.result + 0.3}s` } }, `+${fmt(a.points)}`)))),
        banner ? h('div.q-banner.slam', { style: { animationDelay: `${T.result}s` } }, banner) : null);
    },

    // Rows start in the previous order with old scores, then points count up
    // and everyone slides to their new place.
    scores(g) {
      const ROW = 5.2; // rem
      const rows = g.scoreboard.map((p) => ({ ...p, prev: p.score - (p.delta || 0) }));
      const before = [...rows].sort((a, b) => b.prev - a.prev);
      const max = Math.max(1, ...rows.map((p) => p.score));
      const board = h('div.q-board.anim', { style: { height: `${rows.length * ROW}rem` } });
      const els = new Map();
      before.forEach((p, i) => {
        const score = h('span.q-score', fmt(p.prev));
        const fill = h('div.q-fill', { style: { width: `${(p.prev / max) * 100}%`, background: p.color } });
        const rank = h('span.q-rank', `${i + 1}`);
        const el = h('div.q-row', { style: { top: `${i * ROW}rem`, animationDelay: `${0.08 * i}s` } },
          rank, avatar(p, '3.6rem'), h('span.q-name', p.name),
          h('div.q-bar', fill), score,
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
          const moved = before.findIndex((x) => x.id === p.id) - i;
          r.el.style.top = `${i * ROW}rem`;
          r.rank.textContent = `${p.rank}`;
          if (moved > 0) r.el.classList.add('up');
          if (p.rank === 1) r.el.querySelector('.avatar')?.append(h('span.crown.pop-in', '👑'));
        });
      }, 2300);
      return h('div.q-scores', h('h2.q-heading.slide-up', g.roundTitle ? `Scores after ${g.roundTitle.split(' ·')[0]}` : 'Scores'), board);
    },

    finalVote(g) {
      const cols = Math.min(4, Math.max(2, Math.ceil(g.answers.length / 2)));
      return h('div.q-final',
        promptCard(g),
        h('div.q-final-grid', { style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } },
          g.answers.map((a, i) => h('div.card.q-final-ans.pop-in', { style: { animationDelay: `${0.4 + i * 0.2}s` } },
            h('span.q-letter', `${i + 1}`), fitText(a.text)))),
        voterRow(g.voters),
        h('div.q-progress', `Tap ${g.votesPer > 1 ? `up to ${g.votesPer} favourites` : 'your favourite'} on your phone`));
    },

    // Same grid as the vote, revealed from fewest votes to most.
    finalReveal(g) {
      const step = 2.6;
      const cols = Math.min(4, Math.max(2, Math.ceil(g.answers.length / 2)));
      return h('div.q-final',
        promptCard(g, false),
        h('div.q-final-grid.reveal', { style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } },
          g.answers.map((a, i) => h(`div.card.q-final-card${a.winner ? '.win' : ''}`, { style: { animationDelay: `${i * step + 0.5}s`, '--c': a.author.color } },
            a.winner ? h('div.q-ribbon.small', 'WINNER') : null,
            h('div.q-final-text', fitText(a.text), a.panic ? h('span.chip.pink.q-panic', '🆘') : null),
            h('div.q-byline', h('span.q-by', 'by'), avatar(a.author, '2.2rem', { crown: a.winner }), h('b', a.author.name)),
            h('div.q-voter-chips', a.voters.map((v) => voterChip(v, 0))),
            h('div.q-final-foot', h('span.q-vcount', `${a.votes} vote${a.votes === 1 ? '' : 's'}`), h('span.q-pts', `+${fmt(a.points)}`))))));
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

  // Shutout: drum roll, slam, screen flash, shake, star burst from the card.
  function shutoutShow() {
    setTimeout(() => api.audio?.sfx('shutoutBig'), 2600);
    setTimeout(() => {
      const card = root.querySelector('.q-res.win');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.classList.add('shutout-hit');
      document.body.classList.add('flash');
      setTimeout(() => document.body.classList.remove('flash'), 450);
      api.confetti({ count: 160, duration: 2600, origin: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, spread: true });
      setTimeout(() => api.confetti({ count: 120, duration: 3500 }), 600);
    }, 3100);
  }

  function voterChip(v, delay) {
    return h('span.q-chip', { style: { animationDelay: `${delay}s`, '--c': v.color } }, avatar(v, '1.9rem'), h('span', v.name));
  }

  function voterRow(voters = []) {
    return h('div.q-voter-row', { 'data-live': 'voters' }, voters.map((v) => h(`span.q-vwait${v.done ? '.done' : ''}`, { 'data-id': v.id },
      avatar(v, '2.6rem'), h('span', v.name), h('i', '✓'))));
  }

  function patch(g) {
    const live = (name) => root.querySelector(`[data-live="${name}"]`);
    if (g.phase === 'answer' || g.phase === 'finalAnswer') {
      for (const p of g.players) root.querySelector(`.q-done[data-id="${p.id}"]`)?.classList.toggle('yes', !!p.done);
    }
    if (g.phase === 'vote' && !g.reading) {
      flip('A'); flip('B');
      root.querySelector('.q-vote')?.classList.remove('reading');
      const hint = live('vote-hint');
      if (hint) hint.textContent = 'Vote on your phone!';
    }
    if (g.phase === 'vote' || g.phase === 'finalVote') {
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
        // Measure after layout (and again once fonts and pop-in animations settle).
        const settle = () => { fitStage(root); autoScroll(root); };
        requestAnimationFrame(settle);
        setTimeout(settle, 700);
        setTimeout(settle, 1800);
        document.fonts?.ready.then(settle);
        if (g.phase === 'reveal' && g.kind === 'shutout') shutoutShow();
      } else {
        patch(g);
      }
    },
    destroy() { offCue?.(); removeEventListener('resize', onResize); },
  };
}
