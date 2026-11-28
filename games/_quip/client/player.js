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
      const ta = h('textarea', {
        maxLength: g.maxLength || 200, placeholder: 'Be funny. No pressure.', rows: 3, enterKeyHint: 'send',
        // Keep it exactly as typed: no autocorrect / spellcheck rewriting the joke.
        autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-gramm': 'false',
      });
      const chars = h('div.ph-chars', `0 / ${g.maxLength || 200}`);
      const submit = h('button.btn.pink', { disabled: true }, 'Send it ✓');
      const send = () => {
        const text = ta.value.trim();
        if (!text) return;
        submit.disabled = true;
        api.send({ type: 'answer', matchupId: g.matchupId, text, panic: text === g.panicText });
        api.vibrate(30);
      };
      // Grow with the answer, then scroll inside the box once it hits the cap.
      const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 6}px`; };
      ta.addEventListener('input', () => {
        const max = g.maxLength || 200;
        chars.textContent = `${ta.value.length} / ${max}`;
        chars.classList.toggle('near', ta.value.length > max * 0.9);
        submit.disabled = !ta.value.trim();
        grow();
      });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      submit.addEventListener('click', send);
      const el = h('div.ph-answer.slide-up',
        h('div.card',
          h('div.ph-count', g.final ? 'Final round · everyone answers' : `Prompt ${g.index} of ${g.total}`),
          h('p.ph-prompt', g.prompt),
          ta, chars,
          h('div.ph-actions',
            h('button.btn.white', {
              onClick: () => {
                // Drop the safety answer into the box so you can see it, tweak it, or send it.
                ta.value = g.panicText || '';
                ta.dispatchEvent(new Event('input'));
                ta.focus();
                api.vibrate([20, 40, 20]);
              },
            }, '🆘 Panic'),
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

    // Medal vote: taps hand out gold, silver, bronze in order (tap a medalled
    // answer again to take it back; the rest move up). Every tap counts
    // immediately; with all medals given the phone moves on by itself.
    finalVote(g) {
      const MEDAL = ['🥇', '🥈', '🥉'];
      const NAME = ['gold', 'silver', 'bronze'];
      const picks = [];
      const need = Math.min(g.votesPer, g.options.filter((o) => !o.mine).length);
      const status = h('div.ph-count');
      const paint = () => {
        status.textContent = picks.length < need ? `Tap your ${MEDAL[picks.length]} ${NAME[picks.length]}` : 'Medals given ✓';
      };
      const opts = g.options.map((o) => {
        const badge = h('span.ph-medal');
        const b = h(`button.btn.white.ph-opt${o.mine ? '.mine' : ''}`, { disabled: o.mine }, badge, o.text, o.mine ? h('small', 'yours') : null);
        b.addEventListener('click', () => {
          const at = picks.indexOf(o.id);
          if (at >= 0) picks.splice(at, 1);
          else if (picks.length < need) picks.push(o.id);
          else return;
          for (const [i, el] of opts.entries()) {
            const rank = picks.indexOf(g.options[i].id);
            el.classList.toggle('on', rank >= 0);
            el.dataset.medal = rank >= 0 ? NAME[rank] : '';
            el.querySelector('.ph-medal').textContent = rank >= 0 ? MEDAL[rank] : '';
          }
          paint();
          api.send({ type: 'finalVote', picks: [...picks] });
          api.vibrate(picks.length >= need ? [30, 40, 30] : 15);
        });
        return b;
      });
      paint();
      return h('div.ph-vote.slide-up',
        h('div.card', status, h('p.ph-prompt', g.prompt), h('p.small', `${MEDAL.slice(0, need).join(' ')} · gold is worth the most`)),
        opts);
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
