// The TV. Shows the lobby (join code + QR, players, game picker, Lore Book,
// Hall of Fame) and hands the stage to the running game's host screen.
import { AudioEngine } from './lib/audio.js';
import { avatar } from './lib/avatar.js';
import { confetti } from './lib/confetti.js';
import { $, clear, fmt, h, mountInto } from './lib/dom.js';
import { hostId, load, save } from './lib/identity.js';
import { api, LiveRoom } from './lib/net.js';
import { Voice } from './lib/voice.js';
import qrcode from '/vendor/qrcode.mjs';

const audio = new AudioEngine();
const HOST_ID = hostId();
let voice;
let live;
let view = null;
let isOwner = false;
let game = null; // { type, mod, inst }
let gameLoading = null;
let captionTimer = null;
let lastTick = null;
let sideTab = load('quippy.sideTab', 'tonight');
let sideTabAuto = true;
const memo = new Map();

const stage = $('#stage');

// ------------------------------------------------------------------ boot
$('#start-btn').addEventListener('click', boot);
document.addEventListener('keydown', (e) => { if (!live && (e.key === 'Enter' || e.key === ' ')) boot(); });

async function boot() {
  if (live) return;
  audio.unlock();
  $('#splash').classList.add('hidden');
  $('#app').classList.remove('hidden');
  let cfg = { voice: { provider: 'browser' }, speechLang: 'en-AU', llm: {} };
  try { cfg = await api('/api/config'); } catch { /* offline-ish; carry on */ }
  voice = new Voice(audio, {
    provider: cfg.voice?.provider, lang: cfg.speechLang, onCaption: showCaption,
    serverVoices: cfg.voice?.voices || [], serverVoice: cfg.voice?.voice,
    now: () => (live ? live.serverNow() : Date.now()),
  });
  const params = new URLSearchParams(location.search);
  let room;
  try {
    room = await api('/api/rooms', { hostId: HOST_ID, fresh: params.has('new') });
  } catch (e) {
    mountInto(stage, h('div.card.pop-in', { style: { maxWidth: '40rem', margin: '6rem auto', fontSize: '1.6rem' } },
      h('h2', 'Can’t reach the game server'), h('p', String(e.message || e)), h('button.btn', { onClick: () => location.reload() }, 'Try again')));
    return;
  }
  if (params.has('new')) history.replaceState(null, '', location.pathname);
  live = new LiveRoom(room.code, {
    hello: () => ({ t: 'hello', role: 'host', hostId: HOST_ID }),
    onMessage,
    onStatus: (s) => {
      $('#conn').classList.toggle('hidden', s === 'open');
      if (s === 'gone') { $('#conn').textContent = 'That room has closed.'; setTimeout(() => location.replace('/host?new'), 1500); }
    },
  });
  live.connect();
  setupSettings();
  requestAnimationFrame(tickTimer);
}

function onMessage(msg) {
  if (msg.t === 'welcome') { isOwner = !!msg.owner; return; }
  if (msg.t === 'view') { view = msg.view; render(); return; }
  if (msg.t === 'fx') handleFx(msg.fx);
}

function handleFx(fx) {
  if (fx.say && fx.now) voice?.sayNow(fx.say);
  else if (fx.say) {
    voice?.say(fx.say, fx.ts, {
      scene: fx.scene,
      onStart: fx.cue ? () => emitCue(fx.cue, fx.cueId) : null,
      // When the last answer has been read, tell the server voting can open.
      onEnd: fx.cue === 'B' ? () => live?.game({ type: 'readDone', matchupId: fx.cueId }) : null,
    });
  }
  if (fx.sfx) audio.sfx(fx.sfx);
  if (fx.sfx === 'fanfare') confetti();
}

function showCaption(text) {
  $('#caption-name').textContent = (view?.room?.hostName || 'Monty').toUpperCase();
  $('#caption-text').textContent = text;
  $('#caption').classList.add('show');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => $('#caption').classList.remove('show'), 3500 + text.length * 55);
}

// ---------------------------------------------------------------- render
function render() {
  const room = view.room;
  audio.music(room.music);
  renderTop(room);
  if (room.phase === 'lobby') {
    destroyGame();
    renderLobby(room);
  } else {
    memo.clear();
    renderGame(room, view.game);
  }
}

function renderTop(room) {
  const short = room.joinUrl.replace(/^https?:\/\//, '').replace(/\/[A-Z]{4}$/, '');
  const inGame = room.phase === 'game';
  remember('top', { inGame, short, code: room.code }, () => mountInto($('#top-join'),
    inGame ? h('div.pill', `${short} · `, h('b', room.code)) : null));
}

// Re-render a section only when its data actually changed.
function remember(key, data, fn) {
  const sig = JSON.stringify(data);
  if (memo.get(key) === sig) return false;
  memo.set(key, sig);
  fn(data);
  return true;
}

// ------------------------------------------------------------------ lobby
function renderLobby(room) {
  let root = stage.querySelector('.lobby');
  if (!root) {
    memo.clear();
    root = h('div.lobby',
      h('div.join-col', h('div.card.join-card.tilt-l.pop-in', { id: 'join-card' })),
      h('div.center-col', h('div', { id: 'players-box' }), h('div', { id: 'games-box' }), h('div', { id: 'start-box' })),
      h('div.side', h('div.tabs', { id: 'tabs' }), h('div', { id: 'side-box' }), h('div', { id: 'settings-box' })));
    mountInto(stage, root);
  }

  remember('join', { url: room.joinUrl, code: room.code }, ({ url, code }) => {
    const short = url.replace(/^https?:\/\//, '').replace(/\/[A-Z]{4}$/, '');
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const box = h('div.qr');
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    mountInto($('#join-card'),
      h('p.step', 'Scan to join, or go to'),
      h('div.url', short),
      h('p.code-label', 'and enter'),
      h('div.code', code),
      box);
  });

  const players = room.players.filter((p) => !p.audience);
  const audience = room.players.filter((p) => p.audience && p.connected);
  remember('players', { players, audience: audience.length, owner: isOwner }, () => {
    const max = Math.max(8, players.length);
    const slots = [];
    for (let i = 0; i < max; i++) {
      const p = players[i];
      if (!p) { slots.push(h('div.pslot.empty', h('div.ghost', '?'), h('div.nm', { style: { opacity: 0.5 } }, 'Join!'))); continue; }
      slots.push(h(`div.pslot.pop-in${p.connected ? '' : '.off'}`,
        avatar(p, '5.4rem', { crown: p.vip }),
        h('div.nm', p.name),
        isOwner ? h('button.kick', { onClick: () => live.action('kick', { playerId: p.id }) }, p.isBot ? 'remove' : 'kick') : null));
    }
    mountInto($('#players-box'),
      h('div.players-title', h('h2', players.length ? 'Who’s playing' : 'Waiting for players…'),
        h('span', `${players.length} / 8${audience.length ? ` · ${audience.length} in the audience` : ''}`)),
      h('div.players', slots));
  });

  remember('games', { games: room.games, sel: room.selectedGame, owner: isOwner, llm: room.llm.available }, () => {
    const n = room.games.length;
    mountInto($('#games-box'), h(`div.games${n > 2 ? '.many' : ''}${n > 4 ? '.lots' : ''}`, room.games.map((g, i) => h(`div.card.game-card${g.id === room.selectedGame ? '.sel' : ''}${i % 2 ? '.tilt-r' : '.tilt-l'}`,
      { onClick: () => isOwner && live.action('selectGame', { game: g.id }) },
      h('span.stripe', { style: { background: g.accent || 'var(--pink)' } }),
      g.usesAi ? h('span.chip.teal.tag', room.llm.available ? '🧠 AI' : '🧠 AI-lite') : null,
      h('div.inner', h('h3', g.name), h('p', g.tagline))))));
  });

  const enough = players.filter((p) => p.connected).length >= room.minPlayers;
  remember('start', { enough, owner: isOwner, settings: room.settings, locales: room.locales, charOpts: room.answerCharOptions, n: players.length, min: room.minPlayers, dev: room.dev, vip: room.players.find((p) => p.vip)?.name }, (d) => {
    const vip = d.vip;
    mountInto($('#start-box'),
      h('div.start-row',
        isOwner ? h('button.btn.big.pink', { disabled: !d.enough, onClick: () => live.action('start') }, '▶ Start game') : null,
        h('span.hint', d.enough
          ? (vip ? `…or ${vip} 👑 can start it from their phone.` : 'Ready when you are.')
          : `Need at least ${d.min} players. ${d.n ? `${d.min - d.n} more!` : ''}`),
        isOwner ? h('button.btn.white.mini', { onClick: () => live.action('addBot'), title: 'Add a bot player (great for testing)' }, '+ Bot') : null));
    mountInto($('#settings-box'),
      isOwner ? h('div.card.room-settings.tilt-l',
        h('h3', 'Room settings'),
        h('label', 'Prompts:', h('select', { onChange: (e) => live.action('settings', { settings: { locale: e.target.value } }) },
          d.locales.map((l) => h('option', { value: l.id, selected: l.id === d.settings.locale }, `${l.flag} ${l.label} (${l.prompts})`)))),
        h('label', 'Family friendly:', h('input', { type: 'checkbox', checked: !!d.settings.family, onChange: (e) => live.action('settings', { settings: { family: e.target.checked } }) })),
        h('label', 'Answer time:', h('select', { onChange: (e) => live.action('settings', { settings: { answerSeconds: Number(e.target.value) } }) },
          [45, 60, 90, 120, 150].map((s) => h('option', { value: s, selected: s === d.settings.answerSeconds }, `${s}s`)))),
        h('label', 'Max answer:', h('select', { onChange: (e) => live.action('settings', { settings: { answerChars: Number(e.target.value) } }) },
          (d.charOpts || [200]).map((c) => h('option', { value: c, selected: c === d.settings.answerChars }, `${c} chars`))))) : null);
  });

  renderSide(room);
}

const TABS = [['tonight', 'Tonight'], ['lore', 'Lore Book'], ['fame', 'Hall of Fame']];
let sideRotate = null;
function renderSide(room) {
  if (!sideRotate) {
    sideRotate = setInterval(() => {
      if (!sideTabAuto || view?.room?.phase !== 'lobby') return;
      const i = TABS.findIndex(([k]) => k === sideTab);
      sideTab = TABS[(i + 1) % TABS.length][0];
      memo.delete('side');
      memo.delete('tabs');
      if (view) renderSide(view.room);
    }, 14000);
  }
  remember('tabs', sideTab, () => mountInto($('#tabs'), TABS.map(([k, label]) => h(`button${k === sideTab ? '.on' : ''}`, {
    onClick: () => { sideTab = k; sideTabAuto = false; save('quippy.sideTab', k); memo.delete('side'); memo.delete('tabs'); renderSide(view.room); },
  }, label))));
  remember('side', { tab: sideTab, s: room.session, last: room.lastResults, lore: room.lore, hall: room.hall, lb: room.leaderboard }, () => {
    let body;
    if (sideTab === 'tonight') body = tonightCard(room);
    else if (sideTab === 'lore') body = loreCard(room.lore);
    else body = fameCard(room);
    mountInto($('#side-box'), body);
  });
}

function tonightCard(room) {
  const s = room.session;
  const last = room.lastResults;
  const podium = last ? [...last.players].sort((a, b) => a.rank - b.rank).slice(0, 3) : [];
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);
  return h('div.card.tilt-r.slide-up',
    h('h3', 'Tonight'),
    last ? h('div',
      h('div.small', `Last game: ${room.games.find((g) => g.id === last.gameType)?.name || ''}`),
      h('div.podium-mini', order.map((p) => h('div.p', avatar(p, '3.4rem', { crown: p.rank === 1 }),
        h('div.blk', { style: { height: `${p.rank === 1 ? 4.4 : p.rank === 2 ? 3.2 : 2.4}rem` } }, `#${p.rank}`))))) : null,
    s.standings.length
      ? h('ul.rowlist', s.standings.slice(0, 7).map((p) => h('li', avatar(p, '2.4rem'), h('span.grow', p.name),
        h('span', `${p.wins}🏆`), h('span.num', fmt(p.points)))))
      : h('p.empty-note', 'No games yet tonight. The night is young.'),
    s.highlights?.[0] ? h('p', { style: { marginTop: '1rem' } }, h('small.small', 'Line of the night: '),
      h('span.quote', `“${s.highlights[0].answer}”`), h('small.small', ` — ${s.highlights[0].name}`)) : null);
}

function loreCard(lore) {
  return h('div.card.tilt-l.slide-up',
    h('h3', '📖 Lore Book'),
    lore.jokes.length
      ? h('div', lore.jokes.map((j) => h('div.lore-item',
        h('b', j.title, ' ', h('span.heat', '🔥'.repeat(Math.max(1, Math.round(j.heat / 3))))),
        j.detail ? h('small', j.detail) : null)))
      : h('p.empty-note', 'Empty. Play a game and your running jokes will start showing up here — forever.'),
    lore.taste ? h('p.small', { style: { marginTop: '.8rem' } }, `This crew likes: ${lore.taste}`) : null);
}

function fameCard(room) {
  return h('div.card.tilt-r.slide-up',
    h('h3', '🏆 Hall of Fame'),
    room.leaderboard.length
      ? h('ul.rowlist', room.leaderboard.slice(0, 6).map((p, i) => h('li', h('span.num', `${i + 1}`), avatar(p, '2.4rem'),
        h('span.grow', p.name), h('span', `${p.wins} wins`), h('span.small', `${p.games} games`))))
      : h('p.empty-note', 'Nobody’s famous yet.'),
    room.hall.length ? h('div', { style: { marginTop: '1rem' } }, h('div.small', 'Greatest answers'),
      room.hall.slice(0, 3).map((a) => h('div.lore-item', h('b.quote', `“${a.answer}”`),
        h('small', `${a.name} · ${a.votes}/${a.totalVotes} votes · ${a.prompt}`)))) : null);
}

// ------------------------------------------------------------------- games
function destroyGame() {
  if (game) {
    game.inst?.destroy?.();
    cueListeners.clear();
    game = null;
    clear(stage);
  }
}

const cueListeners = new Set();
function emitCue(cue, id) {
  for (const fn of cueListeners) { try { fn(cue, id); } catch { /* ignore */ } }
}

function hostApi() {
  return {
    onCue: (fn) => { cueListeners.add(fn); return () => cueListeners.delete(fn); },
    h, avatar, fmt, confetti, audio,
    send: (payload) => live.game(payload),
    action: (a, extra) => live.action(a, extra),
    serverNow: () => live.serverNow(),
    room: () => view.room,
    isOwner: () => isOwner,
  };
}

async function renderGame(room, gv) {
  const type = room.gameType;
  const meta = room.games.find((g) => g.id === type);
  if (!meta || !gv) return;
  if (!game || game.type !== type) {
    if (gameLoading?.type === type) return;
    destroyGame();
    clear(stage);
    gameLoading = { type };
    try {
      const mod = await import(`/games/${meta.client}/client/host.js`);
      game = { type, mod, inst: mod.mount(stage, hostApi()) };
    } finally {
      gameLoading = null;
    }
  }
  game.inst.update(view.game, view.room);
}

// ------------------------------------------------------------------- timer
function tickTimer() {
  requestAnimationFrame(tickTimer);
  const g = view?.room?.phase === 'game' ? view.game : null;
  const el = $('#timer');
  if (!g?.timer || !g.deadline) { el.classList.add('hidden'); lastTick = null; return; }
  el.classList.remove('hidden');
  const total = g.timerTotal || (g.phase === 'vote' ? 20000 : g.phase === 'finalVote' ? 30000 : 90000);
  const left = Math.max(0, g.deadline - live.serverNow());
  const secs = Math.ceil(left / 1000);
  $('#timer-num').textContent = secs;
  $('#timer-arc').style.strokeDashoffset = String(276.5 * (1 - Math.min(1, left / total)));
  el.classList.toggle('low', secs <= 5);
  if (secs <= 5 && secs > 0 && secs !== lastTick) audio.sfx('tick');
  lastTick = secs;
}

// ---------------------------------------------------------------- settings
function setupSettings() {
  const dlg = $('#settings');
  $('#settings-btn').addEventListener('click', () => {
    $('#set-voice-on').checked = voice.enabled;
    const local = voice.provider === 'local';
    const current = local ? voice.serverVoice : voice.pickVoice()?.name;
    const options = local
      ? voice.serverVoices.map((v) => h('option', { value: v, selected: v === current }, v))
      : voice.browserVoices().map((v) => h('option', { value: v.name, selected: v.name === current }, `${v.name} (${v.lang})`));
    mountInto($('#set-voice'), options);
    $('#voice-pick-row').classList.toggle('hidden', !['local', 'browser'].includes(voice.provider) || !options.length);
    ['#set-rate', '#set-pitch'].forEach((id) => $(id).closest('.row').classList.toggle('hidden', voice.usesServer()));
    const llm = view?.room?.llm || {};
    $('#brain-note').textContent = `AI brain: ${llm.available ? `${llm.label}${llm.model ? ` · ${llm.model}` : ''}` : 'built-in templates'}${llm.lastError ? ` (last error: ${llm.lastError})` : ''}`;
    $('#voice-note').textContent = {
      local: 'Voice-over comes from your local voice model (TTS_LOCAL_URL). ElevenLabs takes over if it stops answering, then browser voices.',
      gateway: 'Voice-over comes from a speech model on the Vercel AI Gateway (TTS_GATEWAY_MODEL / TTS_GATEWAY_VOICE on the server).',
      elevenlabs: 'Voice-over comes from your ElevenLabs voice (set on the server).',
    }[voice.provider] || 'Using this browser’s built-in voices. Run a local voice model (e.g. Kokoro on :8880) or set ElevenLabs keys on the server for a custom voice.';
    $('#set-rate').value = voice.rate;
    $('#set-pitch').value = voice.pitch;
    $('#set-music').value = audio.musicLevel;
    $('#set-sfx').value = audio.sfxLevel;
    dlg.showModal();
  });
  $('#set-voice-on').addEventListener('change', (e) => voice.setEnabled(e.target.checked));
  $('#set-voice').addEventListener('change', (e) => (voice.provider === 'local' ? voice.setServerVoice(e.target.value) : voice.setVoice(e.target.value)));
  $('#set-rate').addEventListener('input', (e) => { voice.rate = Number(e.target.value); save('quippy.voiceRate', e.target.value); });
  $('#set-pitch').addEventListener('input', (e) => { voice.pitch = Number(e.target.value); save('quippy.voicePitch', e.target.value); });
  $('#set-music').addEventListener('input', (e) => audio.setMusicLevel(Number(e.target.value)));
  $('#set-sfx').addEventListener('input', (e) => audio.setSfxLevel(Number(e.target.value)));
  $('#test-voice').addEventListener('click', () => voice.say('Righto. This is how I sound. Try not to be too impressed.'));
  $('#fullscreen').addEventListener('click', () => document.documentElement.requestFullscreen?.());
  $('#new-room').addEventListener('click', () => location.replace('/host?new'));
  $('#close-settings').addEventListener('click', () => dlg.close());
}
