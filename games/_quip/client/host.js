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

export function mount(root, api) {
  ensureCss('/games/_quip/client/quip.css');
  const { h, avatar, fmt } = api;
  let key = null;

  const keyOf = (g) => [g.phase, g.round, g.matchNo || 0].join('|');

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

    vote(g) {
      return h('div.q-vote',
        h('div.q-meta', `${g.roundTitle || `Round ${g.round}`} · matchup ${g.matchNo} of ${g.matchTotal}`),
        promptCard(g),
        h('div.q-versus',
          g.answers.map((a, i) => h(`div.card.q-ans.pop-in${i ? '.tilt-r' : '.tilt-l'}`, { style: { animationDelay: `${0.6 + i * 0.5}s` } },
            h('span.q-letter', a.key), h('div.q-ans-text', fitText(a.text)))),
          h('div.q-vs.pop-in', { style: { animationDelay: '0.9s' } }, 'VS')),
        voterRow(g.voters),
        h('div.q-progress', 'Vote on your phone'));
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

    scores(g) {
      const max = Math.max(1, ...g.scoreboard.map((p) => p.score));
      return h('div.q-scores',
        h('h2.q-heading.slide-up', 'Scores'),
        h('div.q-board', g.scoreboard.map((p, i) => h('div.q-row.slide-up', { style: { animationDelay: `${0.15 * (g.scoreboard.length - i)}s` } },
          h('span.q-rank', `${p.rank}`), avatar(p, '3.6rem', { crown: p.rank === 1 }), h('span.q-name', p.name),
          h('div.q-bar', h('div.q-fill', { style: { width: `${(p.score / max) * 100}%`, background: p.color } })),
          h('span.q-score', fmt(p.score)),
          p.delta ? h('span.q-delta.pop-in', { style: { animationDelay: '1s' } }, `+${fmt(p.delta)}`) : h('span.q-delta'),
        ))));
    },

    finalVote(g) {
      return h('div.q-final',
        promptCard(g),
        h('div.q-final-grid', g.answers.map((a, i) => h('div.card.q-final-ans.pop-in', { style: { animationDelay: `${0.4 + i * 0.2}s` } },
          h('span.q-letter', `${i + 1}`), fitText(a.text)))),
        voterRow(g.voters),
        h('div.q-progress', `Pick ${g.votesPer > 1 ? `up to ${g.votesPer} favourites` : 'your favourite'} on your phone`));
    },

    finalReveal(g) {
      const step = 2.6;
      return h('div.q-final',
        promptCard(g, false),
        h('div.q-final-list', g.answers.map((a, i) => h(`div.card.q-final-row${a.winner ? '.win' : ''}`, { style: { animationDelay: `${i * step + 0.5}s`, '--c': a.author.color } },
          a.winner ? h('div.q-ribbon.small', 'WINNER') : null,
          h('div.q-final-text', fitText(a.text), a.panic ? h('span.chip.pink.q-panic', '🆘') : null),
          h('div.q-final-mid',
            h('div.q-author', avatar(a.author, '2.6rem'), h('b', a.author.name)),
            h('div.q-voter-chips.left', a.voters.map((v) => voterChip(v, 0)))),
          h('div.q-final-votes', h('span.q-vcount', `${a.votes} vote${a.votes === 1 ? '' : 's'}`), h('span.q-pts', `+${fmt(a.points)}`))))));
    },

    gameOver(g) {
      const top = g.scoreboard.filter((p) => p.rank <= 3);
      const order = [top.find((p) => p.rank === 2), top.find((p) => p.rank === 1), top.find((p) => p.rank === 3)].filter(Boolean);
      const room = api.room();
      return h('div.q-over',
        h('h2.q-heading.slam', g.scoreboard[0] ? `${g.scoreboard.filter((p) => p.rank === 1).map((p) => p.name).join(' & ')} wins!` : 'Game over'),
        h('div.q-podium', order.map((p) => h(`div.q-pod.r${p.rank}.slide-up`, { style: { animationDelay: `${(3 - p.rank) * 0.4}s` } },
          avatar(p, p.rank === 1 ? '9rem' : '6.5rem', { crown: p.rank === 1, className: p.rank === 1 ? 'wiggle' : '' }),
          h('b', p.name), h('span', fmt(p.score)), h('div.q-block', `#${p.rank}`)))),
        g.awards?.length ? h('div.q-awards', g.awards.map((a, i) => h('div.card.q-award.pop-in', { style: { animationDelay: `${1.5 + i * 0.3}s` } },
          h('small', a.title), h('b', a.name)))) : null,
        api.isOwner() ? h('button.btn.teal.q-continue', { onClick: () => api.action('continue') }, 'Back to lobby ▶')
          : h('p.small', `Back to the lobby shortly${room?.vipId ? ' (or when the VIP taps continue)' : ''}.`));
    },
  };

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
        requestAnimationFrame(() => autoScroll(root));
        setTimeout(() => autoScroll(root), 1600);
        document.fonts?.ready.then(() => autoScroll(root));
        if (g.phase === 'reveal' && g.kind === 'shutout') setTimeout(() => api.confetti({ count: 90, duration: 2500 }), 1500);
      } else {
        patch(g);
      }
    },
    destroy() {},
  };
}
