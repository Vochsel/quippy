// Double Take: phone screens.
// mount(root, api) -> { update(gameView, roomView, me), destroy() }
import { selfieCard } from '/js/lib/selfie.js';

function ensureCss(href) {
  if (!document.querySelector(`link[href="${href}"]`)) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
  }
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, name) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
const MOOD = { sent: '🤐', yours: '🤫' };

export function mount(root, api) {
  ensureCss('/games/_quip/client/quip.css');
  ensureCss('/games/double-take/client/double-take.css');
  const { h, mountInto, fmt } = api;
  let key = null;
  let draft = ''; // survives re-renders (reconnects) during the write phase
  let suggestAt = 0;
  let draftTimer = null;

  const keyOf = (g, me) => [g.phase, g.picNo, g.screen, g.textKey || '',
    g.screen === 'selfie' ? `${!!g.done}|${me?.photo || ''}` : ''].join('|');

  // One secret picture prompt: name chips, a suggestion button, send.
  function writeScreen(g) {
    const max = g.maxChars || 160;
    const ta = h('textarea', {
      maxLength: max, rows: 3, enterKeyHint: 'send',
      placeholder: 'e.g. "Sam as a Renaissance portrait, holding a meat pie like a crown"',
      // Exactly as typed: no autocorrect mangling names.
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'sentences', spellcheck: 'false', 'data-gramm': 'false',
    });
    ta.value = draft;
    const chars = h('div.ph-chars');
    const tip = h('p.dt-tip');
    const submit = h('button.btn.pink', 'Send it ✓');
    const names = g.names || [];
    const paint = () => {
      chars.textContent = `${ta.value.length} / ${max}`;
      chars.classList.toggle('near', ta.value.length > max * 0.9);
      submit.disabled = ta.value.trim().length < 3;
      const named = names.some((p) => mentions(ta.value, p.name));
      tip.textContent = !ta.value.trim() ? 'Tap a name to star them. The robot paints them from their selfie.'
        : named ? 'Starring: ' + names.filter((p) => mentions(ta.value, p.name)).map((p) => p.name).join(', ')
          : 'Tip: name someone in the room so the robot paints them.';
      tip.classList.toggle('warn', !!ta.value.trim() && !named);
    };
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 6}px`; };
    const changed = () => {
      draft = ta.value;
      paint(); grow();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => api.send({ type: 'draft', text: draft }), 700);
    };
    const insert = (word) => {
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? start;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && /^\s/.test(after) ? '' : ' ';
      const add = `${pre}${word}${post}`.slice(0, Math.max(0, max - before.length - after.length));
      ta.value = before + add + after;
      const pos = before.length + add.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      changed();
      api.vibrate(10);
    };
    const send = () => {
      const text = ta.value.trim();
      if (text.length < 3) return;
      submit.disabled = true;
      clearTimeout(draftTimer);
      api.send({ type: 'prompt', text });
      api.vibrate(30);
    };
    ta.addEventListener('input', changed);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    submit.addEventListener('click', send);
    const suggest = h('button.btn.white', {
      onClick: () => {
        const list = g.suggestions || [];
        if (!list.length) return;
        ta.value = list[suggestAt % list.length].slice(0, max);
        suggestAt += 1;
        changed();
        api.vibrate([20, 40, 20]);
      },
    }, '💡 Suggest one');
    const el = h('div.ph-answer.dt-write-ph.slide-up',
      h('div.card',
        h('div.ph-count', 'Your secret picture'),
        h('p.ph-prompt', 'Describe a picture starring someone in the room'),
        h('div.dt-chips', names.map((p) => h('button.dt-chip', { type: 'button', onClick: () => insert(p.name) },
          api.avatar(p, '1.6rem'), h('span', p.me ? `${p.name} (you)` : p.name)))),
        ta, chars, tip,
        h('div.ph-actions', (g.suggestions || []).length ? suggest : null, submit)),
      h('p.dt-hint', 'Nobody sees who wrote it. Later, everyone tries to spot your caption among three fakes.'));
    paint();
    requestAnimationFrame(grow);
    return el;
  }

  // Four captions; tap one (taps can change until time's up).
  function guessScreen(g) {
    let pick = g.picked;
    const hint = h('p.dt-hint');
    const btns = g.options.map((text, i) => h('button.dt-opt', {
      onClick: () => {
        pick = i;
        api.send({ type: 'pick', picId: g.picId, choice: i });
        api.vibrate(20);
        paint();
      },
    }, h('span.dt-opt-n', `${i + 1}`), h('span.dt-opt-text', text)));
    const paint = () => {
      btns.forEach((b, i) => {
        b.classList.toggle('on', pick === i);
        b.querySelector('.dt-opt-n').textContent = pick === i ? '✓' : `${i + 1}`;
      });
      hint.textContent = pick === null || pick === undefined
        ? 'Tap the caption that really made the picture on the TV.'
        : 'Locked in. You can still change your mind until time’s up.';
    };
    const el = h('div.dt-guess-ph.slide-up',
      h('div.card', h('div.ph-count', `Picture ${g.picNo} of ${g.picTotal}${g.mult > 1 ? ' · double points' : ''}`),
        h('p.ph-prompt', 'Which caption made the picture on the TV?')),
      h('div.dt-opts', btns),
      hint);
    paint();
    return el;
  }

  const screens = {
    selfie(g, room, me) {
      return selfieCard({ h, me, action: api.action, send: api.send, toast: api.toast, done: g.done });
    },

    watch(g) {
      const emoji = MOOD[g.mood] || (g.phase === 'painting' ? '🎨' : g.phase === 'guess' ? '🔎' : '📺');
      return h('div.ph-watch.pop-in', h('div.emoji', emoji), h('p', g.text || 'Eyes on the TV!'));
    },

    result(g) {
      return h('div.dt-result-ph.pop-in',
        h('div.ph-watch',
          h('div.emoji', g.mine ? (g.gained ? '🎨' : '🕵️') : g.right ? '🎯' : g.picked ? '🙈' : '😶'),
          h('p', g.text),
          g.gained ? h('div.ph-gained', `+${fmt(g.gained)}`) : null),
        h('div.dt-opts.done', g.options.map((o) => h(`div.dt-opt${o.real ? '.real' : '.decoy'}${o.mine ? '.mine' : ''}`,
          h('span.dt-opt-n', o.real ? '✓' : '✗'), h('span.dt-opt-text', o.text),
          o.mine ? h('span.dt-opt-mine', 'you') : null,
          o.count ? h('span.dt-opt-count', `${o.count}`) : null))));
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
      // The phone is the source of truth while writing / picking (it sends
      // every change), so server echoes don't rebuild the screen.
      if (k === key) return;
      key = k;
      if (g.phase !== 'write') { draft = ''; suggestAt = 0; clearTimeout(draftTimer); }
      if (g.screen === 'write') {
        mountInto(root, writeScreen(g));
        api.vibrate([40, 30, 40]);
      } else if (g.screen === 'guess') {
        mountInto(root, guessScreen(g));
        api.vibrate([40, 30, 40]);
      } else {
        const fn = screens[g.screen] || screens.watch;
        mountInto(root, fn(g, room, me));
      }
    },
    destroy() { clearTimeout(draftTimer); },
  };
}
