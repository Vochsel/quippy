// The phone controller: join a room, pick a look, play, and see your stats.
import { avatar, avatarSvg, COLORS, FACES } from './lib/avatar.js';
import { $, fmt, h, mountInto } from './lib/dom.js';
import { deviceId, fingerprint, lastRoom, load, save, setDeviceId, setLastRoom } from './lib/identity.js';
import { api, LiveRoom } from './lib/net.js';

const app = $('#app');
const top = $('#top');

// Room codes never contain vowels or Y (see core/util.js), so /play, /host etc. aren't codes.
const CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
let code = (location.pathname.match(/^\/([A-Za-z]{4})\/?$/)?.[1] || new URLSearchParams(location.search).get('room') || '').toUpperCase();
if (!CODE_RE.test(code)) code = '';
let did = deviceId();
let fp = null;
let profile = null; // public profile from the server
let draft = { name: load('quippy.name', ''), color: load('quippy.color', COLORS[Math.floor(Math.random() * COLORS.length)]), face: Number(load('quippy.face', Math.floor(Math.random() * FACES))) };
let live = null;
let view = null;
let game = null; // { type, inst }
let gameLoading = null;
let lobbyTab = 'me';
let myStats = null;
let statsFetchedAt = 0;
let wakeLock = null;
let lastKey = '';
let editingProfile = false; // keep the edit form up while lobby updates arrive

const vibrate = (p) => { try { navigator.vibrate?.(p); } catch { /* ignore */ } };

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ------------------------------------------------------------------- start
start();

async function start() {
  fp = await fingerprint().catch(() => null);
  if (!code && lastRoom()) {
    const info = await api(`/api/rooms/${lastRoom()}`).catch(() => null);
    if (info) { code = lastRoom(); history.replaceState(null, '', `/${code}`); }
  }
  if (!code) return codeScreen();
  return identify();
}

function logo() {
  return h('div.logo.ph-logo', ['Q', 'U', 'I', 'P', 'P', 'Y'].map((c) => h('span', c)));
}

function codeScreen(error) {
  mountInto(top);
  const input = h('input.code-input', { type: 'text', maxLength: 4, autocomplete: 'off', autocapitalize: 'characters', placeholder: 'ABCD', value: code });
  const go = async () => {
    const c = input.value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(c)) return toast('Room codes are 4 letters — check the TV.');
    try {
      await api(`/api/rooms/${c}`);
      code = c;
      history.replaceState(null, '', `/${c}`);
      identify();
    } catch (e) {
      toast(e.status === 404 ? 'No room with that code. Check the TV!' : 'Can’t reach the game. Same Wi-Fi?');
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  mountInto(app, logo(), h('p.ph-tag', 'Grab the 4-letter code from the TV.'),
    h('div.card.pop-in', h('div.field', h('label', 'Room code'), input), h('button.btn.pink.block.big', { onClick: go }, 'Next ▶')),
    error ? h('p.center', error) : null);
  input.focus();
}

async function identify() {
  try {
    const res = await api('/api/identify', { deviceId: did, fingerprint: fp, room: code });
    profile = res.profile;
    if (profile) {
      draft = { name: profile.name || draft.name, color: profile.color || draft.color, face: profile.face ?? draft.face, photo: profile.photo || null };
      if (lastRoom() === code && draft.name) return connect();
      return joinScreen();
    }
    if (res.suggestion) return welcomeBackScreen(res.suggestion);
  } catch { /* offline identify is fine */ }
  return joinScreen();
}

function welcomeBackScreen(s) {
  mountInto(app, logo(),
    h('div.card.pop-in.center',
      h('h2', 'Welcome back?'),
      h('div.preview', avatar(s, '6rem')),
      h('p', 'Looks like this phone has played before as'),
      h('h2', s.name),
      statsRow(s.stats),
      h('button.btn.pink.block', {
        onClick: () => {
          did = s.id;
          setDeviceId(did);
          profile = s;
          draft = { name: s.name, color: s.color, face: s.face, photo: s.photo || null };
          joinScreen();
        },
      }, 'That’s me!'),
      h('button.btn.white.block', { style: { marginTop: '.7rem' }, onClick: () => joinScreen() }, 'Nope, I’m someone else')));
}

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
  return c.toDataURL('image/jpeg', 0.8);
}

function statsRow(st) {
  if (!st) return null;
  return h('div.welcome-stats',
    h('div', h('b', fmt(st.gamesPlayed)), h('span', 'games')),
    h('div', h('b', fmt(st.gamesWon)), h('span', 'wins')),
    h('div', h('b', fmt(st.points)), h('span', 'points')));
}

function joinScreen({ editing = false } = {}) {
  editingProfile = editing;
  mountInto(top);
  const name = h('input', { type: 'text', maxLength: 14, placeholder: 'Your name', value: draft.name, autocomplete: 'nickname' });
  const preview = h('div.preview');
  const sw = h('div.swatches');
  const faces = h('div.faces');
  // Photo instead of a character: crop to a square, shrink, upload.
  const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  const photoBtns = h('div.photo-btns');
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      toast('Uploading photo…', 4000);
      const image = await squareJpeg(f, 320);
      const res = await api('/api/photo', { deviceId: did, image });
      draft.photo = res.photo;
      paint();
      toast('Looking good ✓', 1400);
    } catch (e) {
      toast(`Couldn't use that photo (${e.message})`);
    }
    file.value = '';
  });
  const paint = () => {
    mountInto(preview, avatar(draft, '6rem'));
    mountInto(photoBtns,
      h('button.btn.white', { onClick: () => file.click() }, draft.photo ? '📷 Change photo' : '📷 Use a photo'),
      draft.photo ? h('button.btn.white', { onClick: () => { draft.photo = null; paint(); } }, '🙂 Use a character') : null);
    mountInto(sw, COLORS.map((c) => h(`button.swatch${c === draft.color ? '.on' : ''}`, {
      style: { background: c }, 'aria-label': c, onClick: () => { draft.color = c; paint(); },
    })));
    mountInto(faces, Array.from({ length: FACES }, (_, i) => {
      const b = h(`button${i === draft.face ? '.on' : ''}`, { onClick: () => { draft.face = i; paint(); } });
      b.append(h('span.avatar', { svg: avatarSvg(draft.color, i) }));
      return b;
    }));
  };
  paint();
  const go = () => {
    draft.name = name.value.trim();
    if (!draft.name) { toast('Pop a name in first.'); name.focus(); return; }
    save('quippy.name', draft.name);
    save('quippy.color', draft.color);
    save('quippy.face', String(draft.face));
    if (editing && live) {
      editingProfile = false;
      live.action('profile', { name: draft.name, color: draft.color, face: draft.face, photo: draft.photo ?? null });
      // Show the change right away; the server's next view confirms it.
      if (view?.me) Object.assign(view.me, { name: draft.name, color: draft.color, face: draft.face, photo: draft.photo ?? null });
      lastKey = '';
      renderTop.key = '';
      renderView();
      toast('Saved ✓', 1400);
    } else {
      connect();
    }
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  mountInto(app, editing ? null : logo(),
    profile && !editing ? h('div.card.center.pop-in', h('h2', `G'day again, ${profile.name}!`), statsRow(profile.stats)) : null,
    h('div.card.slide-up',
      h('div.field', h('label', 'Name'), name),
      preview,
      photoBtns, file,
      h('div.field', h('label', draft.photo ? 'Frame colour' : 'Colour'), sw),
      h('div.field', h('label', 'Face'), faces),
      h('button.btn.pink.block.big', { onClick: go }, editing ? 'Save ✓' : `Join ${code} ▶`)),
    editing ? h('button.btn.white.block', { onClick: () => { editingProfile = false; lastKey = ''; renderView(); } }, 'Cancel') : null);
  if (!draft.name) name.focus();
}

// --------------------------------------------------------------- connect
function connect() {
  if (live) return renderView();
  mountInto(app, h('div.ph-watch', h('span.spinner'), h('p', 'Joining…')));
  live = new LiveRoom(code, {
    hello: () => ({ t: 'hello', role: 'player', profileId: did, fingerprint: fp, name: draft.name, color: draft.color, face: draft.face, photo: draft.photo }),
    onMessage,
    onStatus: (s) => {
      if (s === 'gone') {
        setLastRoom('');
        live = null;
        code = '';
        history.replaceState(null, '', '/play');
        codeScreen('That room has closed. Grab the new code from the TV.');
      }
      document.body.classList.toggle('offline', s === 'closed' || s === 'connecting');
    },
  });
  live.connect();
  window.__quippyLive = live; // handy for debugging from the console
  requestWakeLock();
  requestAnimationFrame(tickTimer);
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      setLastRoom(code);
      if (msg.profile) profile = msg.profile;
      break;
    case 'view':
      view = msg.view;
      renderView();
      break;
    case 'fx':
      if (msg.fx.buzz) vibrate(msg.fx.buzz);
      break;
    case 'kicked':
      setLastRoom('');
      live.close();
      live = null;
      mountInto(top);
      mountInto(app, logo(), h('div.card.center', h('h2', 'You’ve been removed from the room.'),
        h('button.btn.pink', { onClick: () => location.reload() }, 'Rejoin')));
      break;
    case 'error':
      toast(msg.message);
      break;
    default:
      break;
  }
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    }, { once: true });
  } catch { /* not supported */ }
}

// ------------------------------------------------------------------ render
function renderView() {
  if (!view) return;
  const { me, room } = view;
  renderTop(me, room);
  if (room.phase === 'lobby') {
    destroyGame();
    if (editingProfile) return;
    renderLobby(me, room);
  } else {
    lastKey = '';
    editingProfile = false;
    renderGame(me, room, view.game);
  }
}

function renderTop(me, room) {
  if (!me) return;
  const g = view.game;
  const key = JSON.stringify([me.name, me.color, me.face, me.vip, room.code, g?.score, g?.roundTitle, room.phase]);
  if (key === renderTop.key) return;
  renderTop.key = key;
  mountInto(top,
    h('span', { onClick: () => room.phase === 'lobby' && joinScreen({ editing: true }) }, avatar(me, '2.6rem', { crown: me.vip })),
    h('div.who', h('b', me.name), h('small', room.phase === 'game' ? (g?.roundTitle || room.games.find((x) => x.id === room.gameType)?.name || '') : (me.audience ? 'Audience' : 'Player'))),
    room.phase === 'game' && g?.inGame ? h('span.score', fmt(g.score)) : h('span.code', room.code));
}

function renderLobby(me, room) {
  const sel = room.games.find((g) => g.id === room.selectedGame);
  const players = room.players.filter((p) => !p.audience && p.connected);
  const vip = room.players.find((p) => p.vip);
  const key = JSON.stringify([me, room.selectedGame, players.length, room.settings, vip?.id, lobbyTab, myStats, room.session, room.lastResults]);
  if (key === lastKey) return;
  lastKey = key;
  if (lobbyTab === 'me' && Date.now() - statsFetchedAt > 15000) fetchStats();

  const lastMine = room.lastResults?.players.find((p) => p.id === me.id);
  mountInto(app,
    h('div.lobby-me.pop-in', { onClick: () => joinScreen({ editing: true }) }, avatar(me, '7rem', { crown: me.vip }), h('h2', me.name),
      h('div', me.audience ? '🍿 You’re in the audience' : 'You’re in! Eyes on the TV.'),
      h('button.btn.white.edit-me', { onClick: (e) => { e.stopPropagation(); joinScreen({ editing: true }); } }, '✏️ Edit name & look')),
    lastMine ? h('div.card.center', h('b', `Last game: #${lastMine.rank} with ${fmt(lastMine.score)} points`)) : null,
    me.vip
      ? h('div.card',
        h('h2', '👑 You’re the VIP'),
        h('div.game-pick', room.games.map((g) => h(`button.btn${g.id === room.selectedGame ? '.on' : ''}`, {
          onClick: () => live.action('selectGame', { game: g.id }),
        }, g.name, h('small', g.tagline)))),
        h('div.vip-settings',
          h('label', h('input', { type: 'checkbox', checked: !!room.settings.family, onChange: (e) => live.action('settings', { settings: { family: e.target.checked } }) }), 'Family friendly'),
          h('label', 'Time', h('select', { onChange: (e) => live.action('settings', { settings: { answerSeconds: Number(e.target.value) } }) },
            [45, 60, 90, 120, 150].map((s) => h('option', { value: s, selected: s === room.settings.answerSeconds }, `${s}s`)))),
          h('label', 'Max', h('select', { onChange: (e) => live.action('settings', { settings: { answerChars: Number(e.target.value) } }) },
            (room.answerCharOptions || [200]).map((c) => h('option', { value: c, selected: c === room.settings.answerChars }, `${c} chars`))))),
        h('button.btn.pink.block.big', {
          style: { marginTop: '1rem' }, disabled: players.length < room.minPlayers, onClick: () => live.action('start'),
        }, players.length < room.minPlayers ? `Need ${room.minPlayers - players.length} more` : `Start ${sel?.name || ''} ▶`))
      : h('div.card.waiting', `${sel?.name || 'Game'} is up next. Waiting for ${vip ? vip.name : 'the VIP'} 👑 to start…`),
    me.audience
      ? h('button.btn.lime.block', { onClick: () => live.action('toggleAudience') }, '🎮 I want to play')
      : h('button.linkish', { onClick: () => { if (confirm('Sit this game out and just watch & vote?')) live.action('toggleAudience'); } }, 'Sit this one out (just watch & vote)'),
    h('div.tabs-ph',
      h(`button${lobbyTab === 'me' ? '.on' : ''}`, { onClick: () => { lobbyTab = 'me'; lastKey = ''; renderView(); } }, 'My stats'),
      h(`button${lobbyTab === 'tonight' ? '.on' : ''}`, { onClick: () => { lobbyTab = 'tonight'; lastKey = ''; renderView(); } }, 'Tonight')),
    lobbyTab === 'me' ? statsCard() : tonightCard(room));
}

async function fetchStats() {
  statsFetchedAt = Date.now();
  try {
    myStats = await api(`/api/profile/${did}`);
    lastKey = '';
    renderView();
  } catch { /* new player */ }
}

function statsCard() {
  const s = myStats?.profile?.stats;
  if (!s) return h('div.card.center', 'Play a game to start your stats. They’ll follow this phone forever.');
  const c = s.counters || {};
  const winRate = s.gamesPlayed ? Math.round((s.gamesWon / s.gamesPlayed) * 100) : 0;
  const best = myStats.best?.[0] || s.bestAnswer;
  return h('div.card',
    h('div.stat-grid',
      h('div', h('b', fmt(s.gamesPlayed)), h('span', 'games')),
      h('div', h('b', fmt(s.gamesWon)), h('span', 'wins')),
      h('div', h('b', `${winRate}%`), h('span', 'win rate')),
      h('div', h('b', fmt(c.votesReceived)), h('span', 'votes won')),
      h('div', h('b', fmt(c.shutouts)), h('span', 'shutouts')),
      h('div', h('b', fmt(c.panics)), h('span', 'panics'))),
    best ? h('div.best', 'Best line: ', h('q', best.answer), h('div.small', `${best.votes} vote${best.votes === 1 ? '' : 's'} · “${best.prompt}”`)) : null);
}

function tonightCard(room) {
  const st = room.session.standings;
  return h('div.card',
    st.length ? h('ul.list-ph', st.map((p) => h('li', avatar(p, '2rem'), h('span.grow', p.name), h('span', `${p.wins}🏆`), h('b', fmt(p.points)))))
      : h('p.center', 'No games yet tonight.'),
    room.session.highlights?.[0] ? h('p.best', 'Line of the night: ', h('q', room.session.highlights[0].answer), ` — ${room.session.highlights[0].name}`) : null);
}

// ------------------------------------------------------------------- games
function destroyGame() {
  if (game) { game.inst?.destroy?.(); game = null; }
}

async function renderGame(me, room, gv) {
  const meta = room.games.find((g) => g.id === room.gameType);
  if (!meta || !gv) return;
  if (!game || game.type !== room.gameType) {
    if (gameLoading === room.gameType) return;
    destroyGame();
    gameLoading = room.gameType;
    try {
      const mod = await import(`/games/${meta.client}/client/player.js`);
      game = {
        type: room.gameType,
        inst: mod.mount(app, {
          h, mountInto, fmt, avatar, vibrate, toast,
          send: (payload) => live.game(payload),
          action: (a, extra) => live.action(a, extra),
          serverNow: () => live.serverNow(),
        }),
      };
    } finally {
      gameLoading = null;
    }
  }
  game.inst.update(view.game, view.room, view.me);
}

function tickTimer() {
  requestAnimationFrame(tickTimer);
  const g = view?.room?.phase === 'game' ? view.game : null;
  const bar = $('#ph-timer');
  if (!g?.timer || !g.deadline || !live) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const total = g.timerTotal || 60000;
  const left = Math.max(0, g.deadline - live.serverNow());
  $('#ph-timer-fill').style.width = `${Math.min(100, (left / total) * 100)}%`;
  bar.classList.toggle('low', left < 6000);
}

// Phones scroll only when a screen is taller than the viewport (the main
// area is exactly one screen high, with overflow-y: auto).
