// Persistent storage shared by both runtimes. The SQL is plain SQLite, so it
// runs on Node's built-in `node:sqlite` locally and on Cloudflare D1 in
// production. Each runtime supplies a tiny async driver:
//   { all(sql, params), get(sql, params), run(sql, params), exec(sqlScript) }
//
// What lives here: player profiles + lifetime stats, crews (the people who play
// on one TV) and their lore book, the room index, sessions, finished games,
// every answer ever written, and which prompts each crew has already seen.

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, fingerprint TEXT, name TEXT, color TEXT, face INTEGER DEFAULT 0, created_at INTEGER, last_seen INTEGER, stats TEXT NOT NULL DEFAULT '{}')`,
  `CREATE INDEX IF NOT EXISTS profiles_fp ON profiles(fingerprint)`,
  `CREATE TABLE IF NOT EXISTS crews (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, last_seen INTEGER, lore TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}')`,
  `CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, crew_id TEXT, state TEXT NOT NULL DEFAULT '{}', updated_at INTEGER, closed INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS rooms_crew ON rooms(crew_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, room_code TEXT, crew_id TEXT, started_at INTEGER, updated_at INTEGER, summary TEXT)`,
  `CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, session_id TEXT, crew_id TEXT, game_type TEXT, started_at INTEGER, ended_at INTEGER, results TEXT)`,
  `CREATE INDEX IF NOT EXISTS games_crew ON games(crew_id)`,
  `CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT, crew_id TEXT, profile_id TEXT, player_name TEXT, round INTEGER, prompt TEXT, answer TEXT, votes INTEGER, total_votes INTEGER, won INTEGER, panic INTEGER, created_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS answers_crew ON answers(crew_id)`,
  `CREATE INDEX IF NOT EXISTS answers_profile ON answers(profile_id)`,
  `CREATE TABLE IF NOT EXISTS prompt_history (crew_id TEXT, prompt_key TEXT, used_at INTEGER, PRIMARY KEY (crew_id, prompt_key))`,
];

const parse = (s, fallback) => {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

export class SqlStore {
  constructor(driver) {
    this.d = driver;
    this.ready = null;
  }

  init() {
    this.ready ||= (async () => {
      for (const stmt of SCHEMA) await this.d.run(stmt, []);
      // Added later: profile photos. Ignore "duplicate column" on existing DBs.
      await this.d.run('ALTER TABLE profiles ADD COLUMN photo TEXT', []).catch(() => {});
    })();
    return this.ready;
  }

  async all(sql, params = []) { await this.init(); return this.d.all(sql, params); }
  async get(sql, params = []) { await this.init(); return this.d.get(sql, params); }
  async run(sql, params = []) { await this.init(); return this.d.run(sql, params); }

  // ---------- profiles ----------
  #profile(r) {
    return r && {
      id: r.id, fingerprint: r.fingerprint, name: r.name, color: r.color, face: r.face ?? 0, photo: r.photo || null,
      createdAt: r.created_at, lastSeen: r.last_seen, stats: parse(r.stats, {}),
    };
  }

  async getProfile(id) {
    if (!id) return null;
    return this.#profile(await this.get('SELECT * FROM profiles WHERE id = ?', [id]));
  }

  async findProfilesByFingerprint(fp, limit = 3) {
    if (!fp) return [];
    const rows = await this.all('SELECT * FROM profiles WHERE fingerprint = ? ORDER BY last_seen DESC LIMIT ?', [fp, limit]);
    return rows.map((r) => this.#profile(r));
  }

  async upsertProfile(p) {
    const now = Date.now();
    await this.run(
      `INSERT INTO profiles (id, fingerprint, name, color, face, photo, created_at, last_seen, stats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint, name = excluded.name,
         color = excluded.color, face = excluded.face, photo = excluded.photo, last_seen = excluded.last_seen, stats = excluded.stats`,
      [p.id, p.fingerprint || null, p.name || null, p.color || null, p.face ?? 0, p.photo || null, p.createdAt || now, now,
        JSON.stringify(p.stats || {})],
    );
    return { ...p, lastSeen: now };
  }

  // ---------- crews ----------
  async getCrew(id) {
    const r = await this.get('SELECT * FROM crews WHERE id = ?', [id]);
    return r && { id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen,
      lore: parse(r.lore, {}), settings: parse(r.settings, {}) };
  }

  async ensureCrew(id) {
    const now = Date.now();
    await this.run(
      `INSERT INTO crews (id, created_at, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`, [id, now, now]);
    return this.getCrew(id);
  }

  async saveCrewLore(id, lore) {
    await this.run('UPDATE crews SET lore = ?, last_seen = ? WHERE id = ?', [JSON.stringify(lore), Date.now(), id]);
  }

  async saveCrewSettings(id, settings) {
    await this.run('UPDATE crews SET settings = ? WHERE id = ?', [JSON.stringify(settings), id]);
  }

  // ---------- rooms ----------
  // `state` is the full room snapshot. The Node runtime keeps it here; the
  // Cloudflare runtime keeps snapshots in the room's Durable Object and only
  // uses this table as an index (code -> crew, last activity).
  async saveRoom(code, crewId, state = {}) {
    await this.run(
      `INSERT INTO rooms (code, crew_id, state, updated_at, closed) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(code) DO UPDATE SET crew_id = excluded.crew_id, state = excluded.state,
         updated_at = excluded.updated_at, closed = 0`,
      [code, crewId, JSON.stringify(state), Date.now()]);
  }

  async touchRoom(code) {
    await this.run('UPDATE rooms SET updated_at = ? WHERE code = ?', [Date.now(), code]);
  }

  async closeRoom(code) {
    await this.run('UPDATE rooms SET closed = 1 WHERE code = ?', [code]);
  }

  async getRoom(code) {
    const r = await this.get('SELECT * FROM rooms WHERE code = ?', [code]);
    return r && { code: r.code, crewId: r.crew_id, state: parse(r.state, null), updatedAt: r.updated_at, closed: !!r.closed };
  }

  async openRoomForCrew(crewId, sinceMs) {
    const r = await this.get(
      'SELECT code FROM rooms WHERE crew_id = ? AND closed = 0 AND updated_at > ? ORDER BY updated_at DESC LIMIT 1',
      [crewId, sinceMs]);
    return r?.code || null;
  }

  async loadOpenRooms(sinceMs) {
    const rows = await this.all('SELECT * FROM rooms WHERE closed = 0 AND updated_at > ?', [sinceMs]);
    return rows.map((r) => ({ code: r.code, crewId: r.crew_id, state: parse(r.state, null) })).filter((r) => r.state?.code);
  }

  async roomCodeTaken(code, sinceMs) {
    return !!(await this.get('SELECT 1 AS x FROM rooms WHERE code = ? AND closed = 0 AND updated_at > ?', [code, sinceMs]));
  }

  // ---------- sessions & games ----------
  async saveSession(s) {
    await this.run(
      `INSERT INTO sessions (id, room_code, crew_id, started_at, updated_at, summary) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, summary = excluded.summary`,
      [s.id, s.roomCode, s.crewId, s.startedAt, Date.now(), JSON.stringify(s)]);
  }

  async saveGame(g) {
    await this.run(
      `INSERT INTO games (id, session_id, crew_id, game_type, started_at, ended_at, results) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [g.id, g.sessionId, g.crewId, g.gameType, g.startedAt, g.endedAt, JSON.stringify(g.results)]);
  }

  async saveAnswers(gameId, crewId, answers) {
    const now = Date.now();
    for (const a of answers) {
      await this.run(
        `INSERT INTO answers (game_id, crew_id, profile_id, player_name, round, prompt, answer, votes, total_votes, won, panic, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gameId, crewId, a.playerId, a.playerName || null, a.round, a.prompt, a.answer, a.votes ?? 0,
          a.totalVotes ?? 0, a.won ? 1 : 0, a.panic ? 1 : 0, now]);
    }
  }

  // The best answers ever written in front of this crew (vote share, then votes).
  async hallOfFame(crewId, limit = 8) {
    return this.all(
      `SELECT player_name AS name, profile_id AS playerId, prompt, answer, votes, total_votes AS totalVotes, created_at AS at
       FROM answers WHERE crew_id = ? AND total_votes > 1 AND votes > 0
       ORDER BY (CAST(votes AS REAL) / total_votes) DESC, votes DESC, created_at DESC LIMIT ?`, [crewId, limit]);
  }

  async playerBestAnswers(profileId, limit = 3) {
    return this.all(
      `SELECT prompt, answer, votes, total_votes AS totalVotes FROM answers
       WHERE profile_id = ? AND votes > 0 ORDER BY votes DESC, created_at DESC LIMIT ?`, [profileId, limit]);
  }

  async recentAnswers(crewId, limit = 60) {
    return this.all(
      `SELECT player_name AS name, prompt, answer, votes, total_votes AS totalVotes FROM answers
       WHERE crew_id = ? ORDER BY created_at DESC LIMIT ?`, [crewId, limit]);
  }

  async crewLeaderboard(crewId, limit = 10) {
    const rows = await this.all('SELECT results FROM games WHERE crew_id = ? ORDER BY ended_at DESC LIMIT 500', [crewId]);
    const table = new Map();
    for (const r of rows) {
      const res = parse(r.results, null);
      if (!res?.players) continue;
      for (const p of res.players) {
        if (p.isBot) continue;
        const t = table.get(p.id) || { id: p.id, name: p.name, color: p.color, face: p.face, photo: p.photo || null, games: 0, wins: 0, points: 0 };
        t.games += 1;
        t.points += p.score || 0;
        if (res.winnerIds?.includes(p.id)) t.wins += 1;
        table.set(p.id, t);
      }
    }
    return [...table.values()].sort((a, b) => b.wins - a.wins || b.points - a.points).slice(0, limit);
  }

  // ---------- prompt history ----------
  async usedPromptKeys(crewId) {
    const rows = await this.all('SELECT prompt_key FROM prompt_history WHERE crew_id = ?', [crewId]);
    return new Set(rows.map((r) => r.prompt_key));
  }

  async markPromptsUsed(crewId, keys) {
    const now = Date.now();
    for (const k of keys) {
      await this.run(
        `INSERT INTO prompt_history (crew_id, prompt_key, used_at) VALUES (?, ?, ?)
         ON CONFLICT(crew_id, prompt_key) DO UPDATE SET used_at = excluded.used_at`, [crewId, k, now]);
    }
  }

  // When a crew has seen most of the bank, forget the oldest so prompts recycle.
  async recyclePrompts(crewId, keepNewest) {
    await this.run(
      `DELETE FROM prompt_history WHERE crew_id = ? AND prompt_key NOT IN (
         SELECT prompt_key FROM prompt_history WHERE crew_id = ? ORDER BY used_at DESC LIMIT ?)`,
      [crewId, crewId, keepNewest]);
  }
}
