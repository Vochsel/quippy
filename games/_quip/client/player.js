// Phone screens for quip-style games.
// mount(root, api) -> { update(gameView, roomView, me), destroy() }
function ensureCss(href) {
  if (!document.querySelector(`link[href="${href}"]`)) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
  }
}

const MOOD = { win: '🎉', lose: '😬' };

export function mount(root, api) {
  ensureCss('/games/_quip/client/quip.css');
  const { h, mountInto, fmt } = api;
  let key = null;

  const keyOf = (g) => [g.phase, g.round, g.screen, g.matchupId || '', g.textKey || ''].join('|');

  const screens = {
    watch(g) {
      const emoji = MOOD[g.mood] || (g.phase === 'loading' ? '⏳' : g.phase === 'vote' ? '🤐' : '📺');
      return h('div.ph-watch.pop-in',
        h('div.emoji', emoji),
        h('p', g.text || 'Eyes on the TV!'),
        g.gained ? h('div.ph-gained', `+${fmt(g.gained)}`) : null);
    },

    answer(g) {
      const ta = h('textarea', { maxLength: g.maxLength || 80, placeholder: 'Be funny. No pressure.', rows: 3, autocomplete: 'off', enterKeyHint: 'send' });
      const chars = h('div.ph-chars', `0 / ${g.maxLength || 80}`);
      const submit = h('button.btn.pink', { disabled: true }, 'Send it ✓');
      const send = () => {
        const text = ta.value.trim();
        if (!text) return;
        submit.disabled = true;
        api.send({ type: 'answer', matchupId: g.matchupId, text });
        api.vibrate(30);
      };
      ta.addEventListener('input', () => {
        chars.textContent = `${ta.value.length} / ${g.maxLength || 80}`;
        submit.disabled = !ta.value.trim();
      });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      submit.addEventListener('click', send);
      const el = h('div.ph-answer.slide-up',
        h('div.card',
          h('div.ph-count', g.final ? 'Final round · everyone answers' : `Prompt ${g.index} of ${g.total}`),
          h('p.ph-prompt', g.prompt),
          ta, chars,
          h('div.ph-actions',
            h('button.btn.white', { onClick: () => { api.send({ type: 'panic', matchupId: g.matchupId }); api.vibrate([20, 40, 20]); } }, '🆘 Panic'),
            submit)));
      setTimeout(() => ta.focus(), 250);
      return el;
    },

    vote(g) {
      return h('div.ph-vote.slide-up',
        h('div.card', h('div.ph-count', 'Which is funnier?'), h('p.ph-prompt', g.prompt)),
        g.options.map((o) => h('button.btn.white.ph-opt', {
          onClick: (e) => {
            e.currentTarget.classList.add('on');
            api.send({ type: 'vote', matchupId: g.matchupId, choice: o.id });
            api.vibrate(25);
          },
        }, o.text)));
    },

    finalVote(g) {
      const picks = new Set();
      const submit = h('button.btn.pink.block', { disabled: true }, `Lock in ${g.votesPer > 1 ? 'votes' : 'vote'}`);
      const opts = g.options.map((o) => {
        const b = h(`button.btn.white.ph-opt${o.mine ? '.mine' : ''}`, { disabled: o.mine }, o.text, o.mine ? h('small', 'yours') : null);
        b.addEventListener('click', () => {
          if (picks.has(o.id)) picks.delete(o.id);
          else if (picks.size < g.votesPer) picks.add(o.id);
          else if (g.votesPer === 1) { picks.clear(); picks.add(o.id); }
          for (const [i, el] of opts.entries()) el.classList.toggle('on', picks.has(g.options[i].id));
          submit.disabled = picks.size === 0;
          submit.textContent = g.votesPer > 1 ? `Lock in ${picks.size} / ${g.votesPer}` : 'Lock in vote';
          api.vibrate(15);
        });
        return b;
      });
      submit.addEventListener('click', () => { api.send({ type: 'finalVote', picks: [...picks] }); submit.disabled = true; });
      return h('div.ph-vote.slide-up',
        h('div.card', h('div.ph-count', g.votesPer > 1 ? `Pick up to ${g.votesPer} favourites` : 'Pick your favourite'), h('p.ph-prompt', g.prompt)),
        opts, submit);
    },

    gameOver(g, room, me) {
      return h('div.ph-watch.pop-in',
        h('div.emoji', g.rank === 1 ? '🏆' : g.rank && g.rank <= 3 ? '🥳' : '🫠'),
        g.rank ? h('div.ph-rank', `#${g.rank}`) : null,
        g.rank ? h('p', `of ${g.of} · ${fmt(g.score)} points`) : h('p', 'Thanks for judging!'),
        g.awards?.length ? h('p', g.awards.map((a) => h('span.chip', { style: { margin: '.2rem' } }, `🏅 ${a}`))) : null,
        me?.vip ? h('button.btn.teal', { onClick: () => api.action('continue') }, 'Back to lobby ▶') : null);
    },
  };

  return {
    update(g, room, me) {
      if (!g) return;
      const k = keyOf(g);
      if (k === key) return;
      key = k;
      const fn = screens[g.screen] || screens.watch;
      mountInto(root, fn(g, room, me));
      if (g.screen === 'answer' || g.screen === 'vote' || g.screen === 'finalVote') api.vibrate([40, 30, 40]);
    },
    destroy() {},
  };
}
