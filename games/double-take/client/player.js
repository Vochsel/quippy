// Double Take: phone screens.
// mount(root, api) -> { update(gameView, roomView, me), destroy() }
import { selfieCard } from '/js/lib/selfie.js';

function ensureCss(href) {
  if (!document.querySelector(`link[href="${href}"]`)) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
  }
}

export function mount(root, api) {
  ensureCss('/games/_quip/client/quip.css');
  ensureCss('/games/double-take/client/double-take.css');
  const { h, mountInto, fmt } = api;
  let key = null;
  let guess = null; // live guess screen: { qId, patch(g) }

  const keyOf = (g, me) => [g.phase, g.qNo, g.screen, g.textKey || '',
    g.screen === 'selfie' ? `${!!g.done}|${me?.photo || ''}` : ''].join('|');

  // Four captions; tap to toggle, at most two (a third tap swaps out the oldest).
  // The selection is sent whole each time, so the server can't drift from it.
  function guessScreen(g) {
    let picks = [...(g.picked || [])];
    const hint = h('p.dt-hint');
    const btns = g.options.map((text, i) => h('button.dt-opt', {
      onClick: () => {
        if (picks.includes(i)) picks = picks.filter((x) => x !== i);
        else picks = [...picks, i].slice(-2);
        api.send({ type: 'picks', qId: g.qId, picks });
        api.vibrate(picks.includes(i) ? 20 : 10);
        paint();
      },
    }, h('span.dt-opt-n', `${i + 1}`), h('span.dt-opt-text', text)));
    const paint = () => {
      btns.forEach((b, i) => {
        b.classList.toggle('on', picks.includes(i));
        b.querySelector('.dt-opt-n').textContent = picks.includes(i) ? '✓' : `${i + 1}`;
      });
      hint.textContent = picks.length === 2
        ? 'Locked in. You can still change your mind until time’s up.'
        : picks.length === 1 ? 'One more…' : 'Tap the two captions that made the pictures.';
    };
    const el = h('div.dt-guess-ph.slide-up',
      h('div.card', h('div.ph-count', `Question ${g.qNo} of ${g.qTotal}${g.mult > 1 ? ' · double points' : ''}`),
        h('p.ph-prompt', 'Which two captions made the pictures on the TV?')),
      h('div.dt-opts', btns),
      hint);
    paint();
    return {
      el,
      qId: g.qId,
      // The phone is the source of truth while the question is up (it sends
      // the whole selection each tap), so server echoes don't flicker it.
      patch() {},
    };
  }

  const screens = {
    selfie(g, room, me) {
      return selfieCard({ h, me, action: api.action, send: api.send, toast: api.toast, done: g.done });
    },

    watch(g) {
      const emoji = g.phase === 'painting' ? '🎨' : g.phase === 'guess' ? '🔎' : '📺';
      return h('div.ph-watch.pop-in', h('div.emoji', emoji), h('p', g.text || 'Eyes on the TV!'));
    },

    result(g) {
      return h('div.dt-result-ph.pop-in',
        h('div.ph-watch',
          h('div.emoji', g.right === 2 ? '🎯' : g.right === 1 ? '👌' : '🙈'),
          h('div.ph-rank', g.guessed ? `${g.right}/2` : '—'),
          h('p', g.text),
          g.gained ? h('div.ph-gained', `+${fmt(g.gained)}`) : null),
        h('div.dt-opts.done', g.options.map((o) => h(`div.dt-opt${o.real ? '.real' : '.decoy'}${o.mine ? '.mine' : ''}`,
          h('span.dt-opt-n', o.real || '✗'), h('span.dt-opt-text', o.text), o.mine ? h('span.dt-opt-mine', 'you') : null))));
    },

    gameOver(g, room, me) {
      return h('div.ph-watch.pop-in',
        h('div.emoji', g.rank === 1 ? '🏆' : g.rank && g.rank <= 3 ? '🥳' : '🫠'),
        g.rank ? h('div.ph-rank', `#${g.rank}`) : null,
        g.rank ? h('p', `of ${g.of} · ${fmt(g.score)} points`) : h('p', 'Thanks for watching!'),
        g.awards?.length ? h('p', g.awards.map((a) => h('span.chip', { style: { margin: '.2rem' } }, `🏅 ${a}`))) : null,
        me?.vip ? h('button.btn.teal', { onClick: () => api.action('continue') }, 'Back to lobby ▶') : null);
    },
  };

  return {
    update(g, room, me) {
      if (!g) return;
      const k = keyOf(g, me);
      if (k === key) {
        if (guess && g.screen === 'guess' && g.qId === guess.qId) guess.patch(g);
        return;
      }
      key = k;
      guess = null;
      if (g.screen === 'guess') {
        guess = guessScreen(g);
        mountInto(root, guess.el);
        api.vibrate([40, 30, 40]);
      } else {
        const fn = screens[g.screen] || screens.watch;
        mountInto(root, fn(g, room, me));
      }
    },
    destroy() {},
  };
}
