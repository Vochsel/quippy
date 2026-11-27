// A Room is one TV + its phones. It owns the lobby, the session standings and
// the running game, and it is fully serialisable: every change is snapshotted
// so a room (mid-game included) comes back after a server restart or a
// Cloudflare Durable Object eviction, and phones simply reconnect.
//
// Runtimes (server/ for Node, worker/ for Cloudflare) only have to:
//   - construct a Room with deps, call init()
//   - call attach(conn) / detach(conn) / onMessage(conn, msg) for sockets
//     where conn = { id, send(obj), close() }
import { GAMES, gameById } from '../games/registry.js';
import { applyGameResult, pickFreeColor, publicProfile, saveProfileBasics } from './profiles.js';
import { loreSummary, updateCrewLore } from './lore.js';
import { cleanName, FACE_COUNT, PLAYER_COLORS, pick, uid } from './util.js';
import { ImageGen, MEDIA_KEY_RE } from './images.js';

// Rooms without a media store (tests) keep game images in memory.
const memoryMedia = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) || null, put: async (k, bytes) => { m.set(k, bytes); } };
};

const BOT_NAMES = ['Bazza', 'Shazza', 'Davo', 'Kylie', 'Robbo', 'Tezza', 'Macca', 'Jonno', 'Steph', 'Gazza'];
const MAX_PLAYERS_HARD = 16;

function newSession() {
  return { id: uid('s_'), startedAt: Date.now(), games: 0, standings: {}, highlights: [] };
}

export class Room {
  constructor({ code, crewId, deps, snapshot = null }) {
    this.code = code;
    this.crewId = crewId;
    this.deps = deps; // { store, llm, config, content, persist(snapshot), joinUrl, log }
    this.log = deps.log || (() => {});
    this.conns = new Set();
    this.timers = new Map();
    this.laters = new Set();
    this.game = null;
    this.flushQueued = false;
    this.saveHandle = null;
    this.crew = null;
    this.hall = [];
    this.leaderboard = [];
    this.lastJoinLineAt = 0;
    this.usedPrompts = new Set();

    const s = snapshot || {};
    this.createdAt = s.createdAt || Date.now();
    this.players = new Map((s.players || []).map((p) => [p.id, { ...p, connected: !!p.isBot }]));
    this.settings = {
      locale: deps.config.defaultLocale,
      family: false,
      answerSeconds: deps.config.timing.answer,
      answerChars: deps.config.answerChars,
      ...(s.settings || {}),
    };
    this.selectedGame = gameById(s.selectedGame) ? s.selectedGame : GAMES[0].id;
    this.session = s.session || newSession();
    this.lastResults = s.lastResults || null;
    this.gameMeta = s.gameMeta || null;
    this.vipId = s.vipId || null;
    this.music = s.music || 'lobby';
    this.restoreState = s.game || null;
    this.restoreTimers = s.timers || {};
    this.restorePaused = !!s.paused;
    this.hadSnapshot = !!snapshot;
  }

  async init() {
    // Detect the AI brain before any game asks for it (Durable Objects get a
    // fresh client per isolate).
    await this.deps.llm.init?.();
    this.crew = await this.deps.store.ensureCrew(this.crewId);
    if (!this.hadSnapshot && this.crew?.settings) {
      const { locale, family, answerSeconds, answerChars } = this.crew.settings;
      Object.assign(this.settings, Object.fromEntries(
        Object.entries({ locale, family, answerSeconds, answerChars }).filter(([, v]) => v !== undefined)));
    }
    await this.refreshHall();
    this.#prewarmStockLines();
    if (this.restoreState && this.gameMeta) {
      const def = gameById(this.gameMeta.type);
      try {
        this.usedPrompts = await this.deps.store.usedPromptKeys(this.crewId);
        this.game = def.restore(this.makeCtx(def), this.restoreState);
        // Give everyone a moment to reconnect before timers run out.
        const now = Date.now();
        this.paused = this.restorePaused;
        for (const [name, deadline] of Object.entries(this.restoreTimers)) {
          this.setTimer(name, Math.max(deadline - now, 12000));
        }
        if (!this.paused) this.game.resume?.();
        this.log(`room ${this.code}: resumed ${def.id} game`);
      } catch (e) {
        this.log(`room ${this.code}: could not resume game:`, e);
        this.game = null;
        this.gameMeta = null;
      }
    }
    this.restoreState = null;
    this.restoreTimers = {};
  }

  // ---------------------------------------------------------------- sockets
  attach(conn) {
    conn.role = null;
    conn.playerId = null;
    this.conns.add(conn);
  }

  detach(conn) {
    this.conns.delete(conn);
    if (conn.playerId) {
      const p = this.players.get(conn.playerId);
      const stillHere = [...this.conns].some((c) => c.playerId === conn.playerId);
      if (p && !stillHere) {
        p.connected = false;
        p.lastSeen = Date.now();
        if (this.vipId === p.id) this.#electVip();
      }
    }
    this.dirty();
  }

  connectionCount() { return this.conns.size; }

  async onMessage(conn, msg) {
    try {
      if (!msg || typeof msg !== 'object') return;
      if (conn.playerId) { const p = this.players.get(conn.playerId); if (p) p.lastSeen = Date.now(); }
      if (msg.t === 'ping') return conn.send({ t: 'pong', now: Date.now(), id: msg.id });
      if (msg.t === 'hello') return await this.#hello(conn, msg);
      if (msg.t === 'action') return await this.#action(conn, msg);
    } catch (e) {
      this.log(`room ${this.code}: error handling message`, e);
      conn.send({ t: 'error', message: 'Something went sideways. Try again?' });
    }
  }

  async #hello(conn, msg) {
    if (msg.role === 'host') {
      const firstHost = ![...this.conns].some((c) => c !== conn && c.role === 'host');
      conn.role = 'host';
      conn.isOwner = msg.hostId === this.crewId;
      if (firstHost && !this.game) setTimeout(() => this.say(this.content().line('lobbyWelcome')), 600);
      conn.send({ t: 'welcome', role: 'host', code: this.code, owner: conn.isOwner });
      this.dirty();
      return;
    }
    // Player.
    const id = typeof msg.profileId === 'string' && /^[\w-]{6,64}$/.test(msg.profileId) ? msg.profileId : uid('p_');
    const existing = this.players.get(id);
    const taken = new Set([...this.players.values()].filter((p) => p.id !== id).map((p) => p.color));
    const color = pickFreeColor(taken, PLAYER_COLORS.includes(msg.color) ? msg.color : existing?.color);
    const face = Number.isInteger(msg.face) ? Math.abs(msg.face) % FACE_COUNT : existing?.face ?? 0;
    const name = cleanName(msg.name || existing?.name);
    const profile = await saveProfileBasics(this.deps.store, { id, fingerprint: msg.fingerprint, name, color, face, photo: msg.photo });

    let p = existing;
    if (!p) {
      const activePlayers = [...this.players.values()].filter((x) => !x.audience && !x.kicked);
      const def = gameById(this.selectedGame);
      const full = activePlayers.length >= Math.min(def.maxPlayers, MAX_PLAYERS_HARD);
      // Joining mid-game: watch and vote now, play from the next game.
      p = { id, name, color, face, photo: profile.photo || null, isBot: false, audience: !!this.game || full, autoAudience: !!this.game && !full, joinedAt: Date.now() };
      this.players.set(id, p);
      this.fx({ sfx: 'join' });
      if (Date.now() - this.lastJoinLineAt > 2500) {
        this.lastJoinLineAt = Date.now();
        this.say(this.content().line(p.audience ? 'audienceJoin' : 'join', { name }));
      }
    } else if (!this.game) {
      Object.assign(p, { name, color, face });
    }
    p.photo = profile.photo || null;
    p.kicked = false;
    p.connected = true;
    p.lastSeen = Date.now();
    conn.role = 'player';
    conn.playerId = id;
    if (!this.vipId || !this.players.get(this.vipId)?.connected) this.#electVip();
    conn.send({ t: 'welcome', role: 'player', code: this.code, playerId: id, profile: publicProfile(profile) });
    this.dirty();
  }

  #electVip() {
    const candidates = [...this.players.values()]
      .filter((p) => p.connected && !p.isBot && !p.kicked)
      .sort((a, b) => (a.audience - b.audience) || a.joinedAt - b.joinedAt);
    this.vipId = candidates[0]?.id || null;
  }

  async #action(conn, msg) {
    const isOwnerHost = conn.role === 'host' && conn.isOwner;
    const isVip = conn.role === 'player' && conn.playerId === this.vipId;
    const canControl = isOwnerHost || isVip;
    const a = msg.a;

    if (a === 'game') {
      if (!this.game || this.paused) return;
      if (conn.role === 'player') this.game.onAction?.(conn.playerId, msg.payload || {});
      else if (isOwnerHost) this.game.onHostAction?.(msg.payload || {});
      // Any TV may report it finished reading out a matchup.
      else if (conn.role === 'host' && msg.payload?.type === 'readDone') this.game.onHostAction?.(msg.payload);
      this.dirty();
      return;
    }
    if (a === 'profile' && conn.role === 'player' && !this.game) {
      const p = this.players.get(conn.playerId);
      if (!p) return;
      if (msg.name) p.name = cleanName(msg.name);
      if (Number.isInteger(msg.face)) p.face = Math.abs(msg.face) % FACE_COUNT;
      if (PLAYER_COLORS.includes(msg.color)) {
        const taken = new Set([...this.players.values()].filter((x) => x.id !== p.id).map((x) => x.color));
        p.color = pickFreeColor(taken, msg.color);
      }
      const saved = await saveProfileBasics(this.deps.store, { id: p.id, name: p.name, color: p.color, face: p.face, photo: msg.photo });
      p.photo = saved.photo || null;
      this.dirty();
      return;
    }
    if (a === 'toggleAudience' && conn.role === 'player' && !this.game) {
      const p = this.players.get(conn.playerId);
      if (p) { p.audience = !p.audience; p.autoAudience = false; }
      this.dirty();
      return;
    }
    if (!canControl) return;

    switch (a) {
      case 'selectGame':
        if (!this.game && gameById(msg.game)) { this.selectedGame = msg.game; this.fx({ sfx: 'select' }); }
        break;
      case 'start':
        if (!this.game) await this.startGame(msg.game || this.selectedGame);
        break;
      case 'settings':
        if (!this.game) await this.#updateSettings(msg.settings || {});
        break;
      case 'kick': {
        const p = this.players.get(msg.playerId);
        if (p && !this.game) {
          this.players.delete(p.id);
          for (const c of this.conns) {
            if (c.playerId === p.id) { c.send({ t: 'kicked' }); c.playerId = null; c.role = null; }
          }
          if (this.vipId === p.id) this.#electVip();
        }
        break;
      }
      case 'addBot':
        if (!this.game && isOwnerHost) this.addBot();
        break;
      case 'removeBots':
        if (!this.game) for (const p of [...this.players.values()]) if (p.isBot) this.players.delete(p.id);
        break;
      case 'continue':
        this.game?.onContinue?.();
        break;
      case 'abort':
        if (this.game) { this.paused = false; this.#endGame(null); }
        break;
      case 'pause':
        if (isOwnerHost) this.pause();
        break;
      case 'unpause':
        if (isOwnerHost) this.unpause();
        break;
      case 'newSession':
        if (!this.game) { this.session = newSession(); this.lastResults = null; }
        break;
      default:
        return;
    }
    this.dirty();
  }

  async #updateSettings(next) {
    const locales = this.deps.content.locales().map((l) => l.id);
    if (locales.includes(next.locale)) this.settings.locale = next.locale;
    if (typeof next.family === 'boolean') this.settings.family = next.family;
    if ([45, 60, 90, 120, 150].includes(Number(next.answerSeconds))) this.settings.answerSeconds = Number(next.answerSeconds);
    const chars = Number(next.answerChars);
    if (Number.isInteger(chars) && chars >= 40 && chars <= 400) this.settings.answerChars = chars;
    await this.deps.store.saveCrewSettings(this.crewId, { ...this.settings });
  }

  addBot() {
    const used = new Set([...this.players.values()].map((p) => p.name));
    const base = BOT_NAMES.find((n) => !used.has(`${n} 🤖`)) || `Bot ${this.players.size + 1}`;
    const taken = new Set([...this.players.values()].map((p) => p.color));
    const id = uid('bot_');
    this.players.set(id, {
      id, name: `${base} 🤖`, color: pickFreeColor(taken), face: Math.floor(Math.random() * FACE_COUNT),
      isBot: true, audience: false, connected: true, joinedAt: Date.now(),
    });
    this.fx({ sfx: 'join' });
  }

  // ------------------------------------------------------------------ games
  content() {
    return this.deps.content.forRoom({ locale: this.settings.locale, family: this.settings.family });
  }

  async startGame(type) {
    const def = gameById(type);
    if (!def) return;
    const eligible = this.#members()
      .sort((a, b) => a.joinedAt - b.joinedAt);
    if (eligible.length < def.minPlayers) {
      this.say(this.content().line('needMorePlayers', { min: def.minPlayers }));
      return;
    }
    const roster = eligible.slice(0, def.maxPlayers).map((p) => p.id);
    for (const p of eligible.slice(def.maxPlayers)) p.audience = true;
    this.selectedGame = type;
    this.usedPrompts = await this.deps.store.usedPromptKeys(this.crewId);
    this.crew = (await this.deps.store.getCrew(this.crewId)) || this.crew;
    this.gameMeta = { id: uid('g_'), type, startedAt: Date.now(), roster };
    this.lastResults = null;
    this.game = def.create(this.makeCtx(def));
    this.game.start();
    this.dirty();
  }

  // Who's "in the room" for dealing purposes. Phones get locked, apps get
  // backgrounded and sockets drop constantly at a party, so membership is not
  // the same as being connected right now: anyone seen in the last 30 minutes
  // who isn't watching from the audience counts.
  #members() {
    const now = Date.now();
    return [...this.players.values()]
      .filter((p) => !p.audience && !p.kicked)
      .filter((p) => p.isBot || p.connected || now - (p.lastSeen || p.joinedAt || 0) < 30 * 60 * 1000)
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  makeCtx(def) {
    const room = this;
    const timing = { ...this.deps.config.timing, answer: this.settings.answerSeconds };
    return {
      gameType: def.id,
      roomCode: this.code,
      crewId: this.crewId,
      settings: { ...this.settings },
      timing,
      dev: this.deps.config.dev,
      content: this.content(),
      llm: this.deps.llm,
      // AI images: available(), generate({ prompt, reference }) -> { bytes, type }.
      // Off (no key / tests) -> available() is false; draw a placeholder instead.
      images: this.deps.images || (this.deps.images = new ImageGen(this.deps.config.image || {})),
      // Game media (generated images, reference photos). Store bytes here and
      // keep only the key in game state; url(key) is what screens load.
      media: {
        put: async (key, bytes, type) => {
          if (!MEDIA_KEY_RE.test(key)) throw new Error(`bad media key ${key}`);
          room.deps.media ||= memoryMedia();
          await room.deps.media.put(key, bytes, type);
          return key;
        },
        get: async (key) => (MEDIA_KEY_RE.test(key) && room.deps.media ? room.deps.media.get(key) : null),
        url: (key) => `/api/media/${key}`,
      },
      store: this.deps.store,
      log: this.log,
      lore: () => room.crew?.lore || {},
      roster: () => room.gameMeta?.roster || [],
      player: (id) => room.players.get(id),
      playerName: (id) => room.players.get(id)?.name || 'Someone',
      publicPlayer: (id) => {
        const p = room.players.get(id);
        return p ? { id: p.id, name: p.name, color: p.color, face: p.face, photo: p.photo || null, isBot: !!p.isBot } : { id, name: 'Someone', color: '#ccc', face: 0 };
      },
      isConnected: (id) => !!room.players.get(id)?.connected,
      // Members not yet in this game (joined late / missed the deal), up to a cap.
      newcomers: (max) => {
        const roster = new Set(room.gameMeta?.roster || []);
        const out = room.#members().filter((p) => !roster.has(p.id)).map((p) => p.id);
        return out.slice(0, Math.max(0, max - roster.size));
      },
      addToRoster: (ids) => { if (room.gameMeta) room.gameMeta.roster = [...new Set([...room.gameMeta.roster, ...ids])]; },
      hostCount: () => [...room.conns].filter((c) => c.role === 'host').length,
      isBot: (id) => !!room.players.get(id)?.isBot,
      // Everyone who can vote but isn't in the game: audience + latecomers.
      audienceIds: () => [...room.players.values()]
        .filter((p) => p.connected && !p.kicked && !room.gameMeta?.roster.includes(p.id)).map((p) => p.id),
      usedPrompts: this.usedPrompts,
      markPromptsUsed: (keys) => {
        keys.forEach((k) => room.usedPrompts.add(k));
        room.deps.store.markPromptsUsed(room.crewId, keys).catch((e) => room.log('markPromptsUsed', e));
      },
      setTimer: (name, ms) => room.setTimer(name, ms),
      clearTimer: (name) => room.clearTimer(name),
      timerDeadline: (name) => room.timers.get(name)?.deadline || null,
      later: (ms, fn) => room.later(ms, fn),
      update: () => room.dirty(),
      // Persist right now (phase changes), rather than on the debounced timer.
      checkpoint: () => room.saveNow().catch((e) => room.log('checkpoint failed', e)),
      say: (text) => room.say(text),
      // Generate voice audio ahead of time (cached), so it plays on cue.
      prewarm: (texts) => room.prewarm(texts),
      // Resolve once these lines' audio is ready (or after maxMs): lets a
      // game hold a screen until the host can actually say its line.
      voiceReady: (texts, maxMs = 6000) => (room.deps.tts
        ? Promise.race([room.prewarm(texts), new Promise((r) => setTimeout(r, maxMs))])
        : Promise.resolve()),
      line: (key, vars) => room.content().line(key, vars),
      sayLine: (key, vars) => room.say(room.content().line(key, vars)),
      // Say this right now, cutting off anything else (countdown numbers).
      sayNow: (text) => text && room.fx({ say: text, ts: Date.now(), now: true, scene: room.game?.sceneKey?.() }),
      // A line the TV should react to when it starts/finishes speaking it.
      sayCue: (text, cue, id) => text && room.fx({ say: text, ts: Date.now(), cue, cueId: id, scene: room.game?.sceneKey?.() }),
      sfx: (name) => room.fx({ sfx: name }),
      music: (track) => { room.music = track; room.dirty(); },
      buzz: (ids, pattern) => room.buzz(ids, pattern),
      finish: (results) => room.#endGame(results),
    };
  }

  setTimer(name, ms) {
    this.clearTimer(name);
    if (this.paused) {
      // Frozen: remember how long it had left; it starts when the room resumes.
      this.timers.set(name, { deadline: null, remaining: ms, handle: null });
      this.save();
      return Date.now() + ms;
    }
    const deadline = Date.now() + ms;
    const handle = setTimeout(() => {
      this.timers.delete(name);
      try { this.game?.onTimer?.(name); } catch (e) { this.log(`room ${this.code}: timer ${name} failed`, e); }
      this.dirty();
    }, ms);
    this.timers.set(name, { deadline, handle });
    this.save();
    return deadline;
  }

  // Pause: freeze every timer (keeping what's left) and cancel cosmetic
  // delays; the game picks its bots/countdown back up on resume.
  pause() {
    if (this.paused || !this.game) return;
    this.paused = true;
    const now = Date.now();
    for (const [name, t] of this.timers) {
      clearTimeout(t.handle);
      this.timers.set(name, { deadline: null, remaining: Math.max(1000, (t.deadline ?? now) - now), handle: null });
    }
    for (const h of this.laters) clearTimeout(h);
    this.laters.clear();
    this.fx({ pause: true });
    this.say(this.content().line('paused'));
    this.dirty();
  }

  unpause() {
    if (!this.paused) return;
    this.paused = false;
    for (const [name, t] of [...this.timers]) {
      if (t.deadline === null) this.setTimer(name, Math.max(3000, t.remaining));
    }
    this.game?.onUnpause?.();
    this.say(this.content().line('unpaused'));
    this.dirty();
  }

  clearTimer(name) {
    const t = this.timers.get(name);
    if (t) clearTimeout(t.handle);
    this.timers.delete(name);
  }

  later(ms, fn) {
    // Cosmetic delays (bots, countdown calls) don't run while paused; the
    // game re-schedules them in onUnpause().
    if (this.paused) return () => {};
    const handle = setTimeout(() => {
      this.laters.delete(handle);
      try { fn(); } catch (e) { this.log(`room ${this.code}: later() failed`, e); }
      this.dirty();
    }, ms);
    this.laters.add(handle);
    return () => { clearTimeout(handle); this.laters.delete(handle); };
  }

  #clearGameTimers() {
    for (const t of this.timers.values()) clearTimeout(t.handle);
    this.timers.clear();
    for (const h of this.laters) clearTimeout(h);
    this.laters.clear();
  }

  async #endGame(results) {
    const meta = this.gameMeta;
    this.#clearGameTimers();
    this.game = null;
    this.gameMeta = null;
    this.paused = false;
    this.music = 'lobby';
    // People who joined mid-game were parked in the audience: deal them in now.
    for (const p of this.players.values()) {
      if (p.autoAudience) { p.audience = false; p.autoAudience = false; }
    }
    if (results && meta) {
      this.lastResults = {
        gameType: meta.type,
        players: results.players.map(({ id, name, color, face, photo, score, rank, isBot }) => ({ id, name, color, face, photo, score, rank, isBot })),
        winnerIds: results.winnerIds,
        awards: results.awards || [],
        highlights: (results.highlights || []).slice(0, 3),
      };
      this.#updateSession(results);
      this.dirty();
      try {
        await this.#recordResults(meta, results);
      } catch (e) {
        this.log(`room ${this.code}: failed to record results`, e);
      }
    }
    this.dirty();
  }

  #updateSession(results) {
    const s = this.session;
    s.games += 1;
    for (const p of results.players) {
      const st = s.standings[p.id] || { id: p.id, name: p.name, color: p.color, face: p.face, games: 0, wins: 0, points: 0 };
      Object.assign(st, { name: p.name, color: p.color, face: p.face, photo: p.photo || null });
      st.games += 1;
      st.points += p.score || 0;
      if (results.winnerIds.includes(p.id)) st.wins += 1;
      s.standings[p.id] = st;
    }
    s.highlights = [...(results.highlights || []), ...s.highlights]
      .sort((a, b) => (b.votes || 0) - (a.votes || 0)).slice(0, 10);
  }

  async #recordResults(meta, results) {
    const { store, llm } = this.deps;
    const humans = results.players.filter((p) => !p.isBot);
    await store.saveGame({
      id: meta.id, sessionId: this.session.id, crewId: this.crewId, gameType: meta.type,
      startedAt: meta.startedAt, endedAt: Date.now(), results,
    });
    const answers = (results.answers || []).filter((a) => !this.players.get(a.playerId)?.isBot);
    if (answers.length) await store.saveAnswers(meta.id, this.crewId, answers);
    for (const p of humans) {
      const prof = await store.getProfile(p.id);
      if (!prof) continue;
      prof.stats = applyGameResult(prof.stats, p, meta.type, results.winnerIds.includes(p.id));
      await store.upsertProfile(prof);
    }
    await store.saveSession({ ...this.session, roomCode: this.code, crewId: this.crewId });
    // Lore can take a few seconds when a model is involved; the lobby updates when it lands.
    const lore = await updateCrewLore({
      store, llm, crewId: this.crewId, answers,
      players: humans.map((p) => p.name), localeHint: this.content().meta.llmHint, log: this.log,
    });
    if (this.crew) this.crew.lore = lore;
    await this.refreshHall();
    this.dirty();
  }

  async refreshHall() {
    try {
      this.hall = await this.deps.store.hallOfFame(this.crewId, 6);
      this.leaderboard = await this.deps.store.crewLeaderboard(this.crewId, 8);
    } catch (e) {
      this.log('refreshHall', e);
    }
  }

  // --------------------------------------------------------- views & effects
  // `ts` lets the TV drop lines that arrive too late to still make sense.
  say(text) { if (text) this.fx({ say: text, ts: Date.now(), scene: this.game?.sceneKey?.() || 'lobby' }); }

  // Host lines with no {placeholders} are the same for everyone: generate
  // them once per server process (then they live in the cache for good).
  #prewarmStockLines() {
    const pack = this.content().pack;
    const key = `${pack.id}`;
    Room.warmed ||= new Set();
    if (Room.warmed.has(key) || !this.deps.tts) return;
    Room.warmed.add(key);
    const stock = Object.entries(pack.host)
      .filter(([k]) => !k.startsWith('phone') && !k.startsWith('award_') && !/Title/.test(k))
      .flatMap(([, v]) => v).filter((t) => !t.includes('{'));
    this.prewarm(stock);
  }

  prewarm(texts) {
    const tts = this.deps.tts;
    if (!tts) return Promise.resolve();
    const list = [...new Set((texts || []).filter((t) => typeof t === 'string' && t.trim()))];
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const t = list[i++];
        await tts.speak(t).catch(() => null);
      }
    };
    // A few at a time: plenty of headroom before each line is needed.
    return Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  }

  fx(event) {
    for (const c of this.conns) if (c.role === 'host') c.send({ t: 'fx', fx: event });
  }

  buzz(ids, pattern = [60]) {
    const set = ids ? new Set(ids) : null;
    for (const c of this.conns) {
      if (c.role === 'player' && (!set || set.has(c.playerId))) c.send({ t: 'fx', fx: { buzz: pattern } });
    }
  }

  dirty() {
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.#flush());
    }
    this.save();
  }

  #flush() {
    this.flushQueued = false;
    const now = Date.now();
    let hostMsg = null;
    for (const c of this.conns) {
      try {
        if (c.role === 'host') {
          hostMsg ||= JSON.stringify({ t: 'view', now, view: this.hostView() });
          c.sendRaw ? c.sendRaw(hostMsg) : c.send(JSON.parse(hostMsg));
        } else if (c.role === 'player' && c.playerId) {
          c.send({ t: 'view', now, view: this.playerView(c.playerId) });
        }
      } catch (e) {
        this.log(`room ${this.code}: view failed`, e);
      }
    }
  }

  publicPlayers() {
    return [...this.players.values()]
      .filter((p) => !p.kicked)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        id: p.id, name: p.name, color: p.color, face: p.face, photo: p.photo || null, isBot: !!p.isBot,
        audience: !!p.audience, connected: !!p.connected, vip: p.id === this.vipId,
      }));
  }

  roomView() {
    const def = gameById(this.selectedGame);
    return {
      code: this.code,
      joinUrl: this.deps.joinUrl(this.code),
      phase: this.game ? 'game' : 'lobby',
      players: this.publicPlayers(),
      vipId: this.vipId,
      selectedGame: this.selectedGame,
      games: GAMES.map((g) => ({
        id: g.id, name: g.name, tagline: g.tagline, minPlayers: g.minPlayers, maxPlayers: g.maxPlayers,
        usesAi: !!g.usesAi, accent: g.accent, client: g.client || g.id,
      })),
      minPlayers: def.minPlayers,
      maxPlayers: Math.min(def.maxPlayers, MAX_PLAYERS_HARD),
      settings: this.settings,
      answerCharOptions: [...new Set([80, 120, 200, 280, this.deps.config.answerChars])].sort((a, b) => a - b),
      locales: this.deps.content.locales(),
      session: {
        startedAt: this.session.startedAt, games: this.session.games,
        standings: Object.values(this.session.standings).sort((a, b) => b.wins - a.wins || b.points - a.points),
        highlights: this.session.highlights.slice(0, 3),
      },
      lore: loreSummary(this.crew?.lore),
      hall: this.hall,
      leaderboard: this.leaderboard,
      lastResults: this.lastResults,
      llm: this.deps.llm.status(),
      gameType: this.gameMeta?.type || null,
      music: this.music,
      paused: !!this.paused,
      hostName: this.content().meta.hostName || 'Monty',
      dev: this.deps.config.dev,
    };
  }

  hostView() {
    return { room: this.roomView(), game: this.game ? this.game.hostView() : null };
  }

  playerView(pid) {
    const p = this.players.get(pid);
    const room = this.roomView();
    return {
      me: p ? { id: p.id, name: p.name, color: p.color, face: p.face, photo: p.photo || null, audience: !!p.audience, vip: pid === this.vipId } : null,
      room: {
        code: room.code, phase: room.phase, players: room.players, vipId: room.vipId, selectedGame: room.selectedGame,
        games: room.games, minPlayers: room.minPlayers, settings: room.settings, locales: room.locales,
        answerCharOptions: room.answerCharOptions,
        session: room.session, lastResults: room.lastResults, gameType: room.gameType, hostName: room.hostName, paused: room.paused,
        llm: { available: room.llm.available, label: room.llm.label },
      },
      game: this.game && p ? this.game.playerView(pid) : null,
    };
  }

  // ------------------------------------------------------------ persistence
  snapshot() {
    return {
      code: this.code,
      crewId: this.crewId,
      createdAt: this.createdAt,
      settings: this.settings,
      players: [...this.players.values()].map(({ connected, ...rest }) => rest),
      selectedGame: this.selectedGame,
      session: this.session,
      lastResults: this.lastResults,
      vipId: this.vipId,
      music: this.music,
      gameMeta: this.gameMeta,
      game: this.game ? this.game.serialize() : null,
      timers: Object.fromEntries([...this.timers.entries()].map(([k, v]) => [k, v.deadline ?? Date.now() + (v.remaining || 0)])),
      paused: !!this.paused,
      savedAt: Date.now(),
    };
  }

  save() {
    if (this.saveHandle) return;
    this.saveHandle = setTimeout(() => {
      this.saveHandle = null;
      this.saveNow().catch((e) => this.log(`room ${this.code}: save failed`, e));
    }, 250);
  }

  async saveNow() {
    if (this.saveHandle) { clearTimeout(this.saveHandle); this.saveHandle = null; }
    // Chain saves so an older snapshot can never land after a newer one.
    this.saving = (this.saving || Promise.resolve()).then(() => this.deps.persist(this.snapshot()));
    return this.saving;
  }

  randomBotName() { return pick(BOT_NAMES); }
}
