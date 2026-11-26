// Picture Duel: phone screens.
// mount(root, api) -> { update(gameView, roomView, me), destroy() }
import { api as http, LIVE } from '/js/lib/net.js';
import { deviceId } from '/js/lib/identity.js';

function ensureCss(href) {
  if (!document.querySelector(`link[href="${href}"]`)) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
  }
}

const src = (url) => (url ? LIVE + url : '');
const MOOD = { win: '🎉', lose: '😬' };

// Crop to a centred square and shrink to a JPEG data URL (same as profile photos).
async function squareJpeg(fileObj, size) {
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
  return c.toDataURL('image/jpeg', 0.82);
}

export function mount(root, api) {
  ensureCss('/games/_quip/client/quip.css');
  ensureCss('/games/picture-duel/client/picture.css');
  const { h, mountInto, fmt } = api;
  let key = null;
  let create = null; // live create screen: { matchupId, patch(g) }
  let tick = null;
  // Reference photo + draft prompt survive re-renders (per brief).
  const drafts = {};

  const keyOf = (g) => [g.phase, g.round, g.screen, g.matchupId || '', g.textKey || ''].join('|');

  function createScreen(g) {
    const d = (drafts[g.matchupId] ||= { text: '', ref: null, refPreview: null });
    const ta = h('textarea', {
      maxLength: g.maxChars || 240, rows: 3, placeholder: 'Describe the picture… e.g. "a koala in a tux spilling red wine, cartoon"',
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'sentences', spellcheck: 'false', 'data-gramm': 'false',
    });
    ta.value = d.text;
    const chars = h('div.ph-chars');
    const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const refBox = h('div.pd-refbox');
    const genBtn = h('button.btn.pink.pd-gen');
    const status = h('div.pd-status');
    const gallery = h('div.pd-gallery');
    const sendBtn = h('button.btn.lime.block.pd-send', 'Send this one ✓');
    let view = g;
    let uploading = false;
    let picked = g.picked;
    let lastCount = g.tries.length;

    const paintChars = () => { chars.textContent = `${ta.value.length} / ${view.maxChars || 240}`; };
    const paintRef = () => {
      mountInto(refBox,
        d.refPreview ? h('img.pd-refthumb', { src: d.refPreview, alt: 'reference photo' }) : null,
        h('button.btn.white.pd-refbtn', { disabled: uploading, onClick: () => file.click() },
          uploading ? 'Uploading…' : d.ref ? '📷 Change photo' : '📷 Add a photo (optional)'),
        d.ref ? h('button.btn.white.pd-refbtn', { onClick: () => { d.ref = null; d.refPreview = null; paintRef(); } }, '✕') : null);
    };
    const paintButtons = () => {
      const busy = !!view.busy;
      genBtn.disabled = busy || uploading || !ta.value.trim() || view.triesLeft <= 0 || view.closing;
      genBtn.textContent = view.triesLeft <= 0 ? 'No tries left' : view.tries.length ? `🎨 Try again (${view.triesLeft} left)` : `🎨 Generate (${view.triesLeft} tries)`;
      sendBtn.disabled = picked === null || picked === undefined || !view.tries[picked] || busy;
      sendBtn.classList.toggle('hidden', !view.tries.length);
    };
    const paintStatus = () => {
      clearInterval(tick);
      if (view.busy) {
        const started = view.busy.at || Date.now();
        const bar = h('div.pd-bar', h('div'));
        const label = h('span', 'Painting…');
        mountInto(status, h('div.pd-painting', h('span.spinner'), label), bar);
        const expect = view.ai ? 9000 : 1500;
        const step = () => {
          const t = Math.max(0, api.serverNow() - started);
          bar.firstChild.style.width = `${Math.min(95, (1 - Math.exp(-t / expect)) * 100)}%`;
          label.textContent = `Painting… ${Math.round(t / 1000)}s`;
        };
        step();
        tick = setInterval(step, 250);
      } else if (view.error) {
        mountInto(status, h('div.pd-error', view.error));
      } else {
        mountInto(status);
      }
    };
    const paintGallery = () => {
      const slots = [...view.tries.map((t, i) => ({ t, i })), ...(view.busy ? [{ busy: true }] : [])];
      mountInto(gallery, slots.map((sl) => {
        if (sl.busy) return h('div.pd-tile.pd-tile-busy', h('span.spinner'));
        const tile = h(`button.pd-tile${sl.i === picked ? '.on' : ''}`, {
          onClick: () => {
            picked = sl.i;
            api.send({ type: 'pick', matchupId: view.matchupId, idx: sl.i });
            api.vibrate(15);
            paintGallery(); paintButtons();
          },
        }, h('img', { src: src(sl.t.url), alt: sl.t.prompt }), h('span.pd-tile-n', `${sl.i + 1}`), sl.t.ref ? h('span.pd-tile-ref', '📷') : null);
        return tile;
      }));
      const p = view.tries[picked];
      if (p) gallery.append(h('p.pd-picked-prompt', `“${p.prompt}”`));
    };

    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      uploading = true; paintRef(); paintButtons();
      try {
        const image = await squareJpeg(f, 512);
        const res = await http('/api/media/ref', { deviceId: deviceId(), image });
        d.ref = res.key; d.refPreview = image;
        api.toast('Photo added ✓', 1200);
      } catch (e) {
        api.toast(`Couldn't use that photo (${e.message})`);
      }
      uploading = false; paintRef(); paintButtons();
    });
    ta.addEventListener('input', () => { d.text = ta.value; paintChars(); paintButtons(); });
    genBtn.addEventListener('click', () => {
      const prompt = ta.value.trim();
      if (!prompt || genBtn.disabled) return;
      genBtn.disabled = true;
      api.send({ type: 'generate', matchupId: view.matchupId, prompt, ref: d.ref || undefined });
      api.vibrate(30);
      ta.blur();
    });
    sendBtn.addEventListener('click', () => {
      if (sendBtn.disabled) return;
      sendBtn.disabled = true;
      api.send({ type: 'submit', matchupId: view.matchupId, idx: picked });
      api.vibrate([30, 40, 30]);
    });

    const el = h('div.pd-create-ph.slide-up',
      h('div.card',
        h('div.ph-count', g.total > 1 ? `Brief ${g.index} of ${g.total}` : 'Your brief'),
        h('p.ph-prompt', g.prompt),
        ta, chars, refBox, file,
        h('div.ph-actions', genBtn),
        status),
      gallery,
      sendBtn,
      h('p.pd-hint', 'Not sure? The one you’ve picked gets sent when time runs out.'));

    const patch = (next) => {
      view = next;
      if (next.tries.length !== lastCount) { lastCount = next.tries.length; picked = next.picked; }
      if (picked === null || picked === undefined) picked = next.picked;
      paintStatus(); paintGallery(); paintButtons();
    };
    paintChars(); paintRef(); patch(g);
    return { el, patch, matchupId: g.matchupId };
  }

  const screens = {
    watch(g) {
      const emoji = MOOD[g.mood] || (g.phase === 'loading' ? '🎨' : g.phase === 'vote' ? '🤐' : g.phase === 'create' ? '🖼️' : '📺');
      return h('div.ph-watch.pop-in',
        h('div.emoji', emoji),
        h('p', g.text || 'Eyes on the TV!'),
        g.gained ? h('div.ph-gained', `+${fmt(g.gained)}`) : null);
    },

    vote(g) {
      return h('div.pd-vote-ph.slide-up',
        h('div.card', h('div.ph-count', 'Which picture nails it?'), h('p.ph-prompt', g.prompt)),
        h('div.pd-vote-opts', g.options.map((o) => h('button.pd-opt', {
          onClick: (e) => {
            e.currentTarget.classList.add('on');
            for (const b of e.currentTarget.parentElement.children) b.disabled = true;
            api.send({ type: 'vote', matchupId: g.matchupId, choice: o.id });
            api.vibrate(25);
          },
        }, h('img', { src: src(o.url), alt: `Picture ${o.id}` }), h('span.q-letter', o.id)))));
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
      if (k === key) {
        if (create && g.screen === 'create' && g.matchupId === create.matchupId) create.patch(g);
        return;
      }
      key = k;
      clearInterval(tick);
      create = null;
      if (g.screen === 'create') {
        create = createScreen(g);
        mountInto(root, create.el);
      } else {
        const fn = screens[g.screen] || screens.watch;
        mountInto(root, fn(g, room, me));
      }
      if (g.screen === 'create' || g.screen === 'vote') api.vibrate([40, 30, 40]);
    },
    destroy() { clearInterval(tick); },
  };
}
