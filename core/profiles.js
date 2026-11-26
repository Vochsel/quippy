// Player identity and lifetime stats.
//
// Each phone keeps a random device id in localStorage (+ a cookie). That id is
// the profile id. If storage gets wiped we also keep a soft browser
// fingerprint; a fingerprint match never silently merges people (two identical
// phones can share one) — the phone is asked "Are you Bazza?" and the player
// confirms.
import { cleanName, PLAYER_COLORS, FACE_COUNT } from './util.js';

export function emptyStats() {
  return {
    gamesPlayed: 0, gamesWon: 0, points: 0, podiums: 0,
    winStreak: 0, bestWinStreak: 0,
    counters: {}, // game-reported tallies, e.g. shutouts, votesReceived, panics
    byGame: {}, // { [gameType]: { played, won, points, bestScore } }
    bestAnswer: null, // { prompt, answer, votes, totalVotes, at }
    firstPlayed: null, lastPlayed: null,
  };
}

export function publicProfile(p) {
  if (!p) return null;
  const s = { ...emptyStats(), ...(p.stats || {}) };
  return {
    id: p.id, name: p.name, color: p.color, face: p.face ?? 0, photo: p.photo || null,
    stats: {
      gamesPlayed: s.gamesPlayed, gamesWon: s.gamesWon, points: s.points, podiums: s.podiums,
      bestWinStreak: s.bestWinStreak, counters: s.counters, byGame: s.byGame, bestAnswer: s.bestAnswer,
      firstPlayed: s.firstPlayed, lastPlayed: s.lastPlayed,
    },
  };
}

export async function identify(store, { deviceId, fingerprint, exclude = [] }) {
  const profile = deviceId ? await store.getProfile(deviceId) : null;
  if (profile) {
    if (fingerprint && profile.fingerprint !== fingerprint) {
      await store.upsertProfile({ ...profile, fingerprint });
    }
    return { profile: publicProfile(profile), suggestion: null };
  }
  const matches = await store.findProfilesByFingerprint(fingerprint);
  const suggestion = matches.find((m) => m.name && m.id !== deviceId && !exclude.includes(m.id));
  return { profile: null, suggestion: suggestion ? publicProfile(suggestion) : null };
}

export const PHOTO_RE = /^[\w-]{6,64}-[0-9a-f]{8,40}\.jpg$/;

// photo: a stored photo file name, null to clear it, undefined to keep it.
export async function saveProfileBasics(store, { id, fingerprint, name, color, face, photo }) {
  const existing = await store.getProfile(id);
  const profile = {
    id,
    fingerprint: fingerprint || existing?.fingerprint || null,
    name: cleanName(name || existing?.name),
    color: PLAYER_COLORS.includes(color) ? color : existing?.color || PLAYER_COLORS[0],
    face: Number.isInteger(face) && face >= 0 && face < FACE_COUNT ? face : existing?.face ?? 0,
    photo: photo === null ? null : PHOTO_RE.test(photo || '') ? photo : existing?.photo || null,
    createdAt: existing?.createdAt,
    stats: existing?.stats || emptyStats(),
  };
  await store.upsertProfile(profile);
  return profile;
}

// Fold one finished game into a player's lifetime stats.
export function applyGameResult(stats, result, gameType, won, now = Date.now()) {
  const s = { ...emptyStats(), ...stats };
  s.counters = { ...(s.counters || {}) };
  s.byGame = { ...(s.byGame || {}) };
  s.gamesPlayed += 1;
  s.points += result.score || 0;
  if (won) {
    s.gamesWon += 1;
    s.winStreak = (s.winStreak || 0) + 1;
    s.bestWinStreak = Math.max(s.bestWinStreak || 0, s.winStreak);
  } else {
    s.winStreak = 0;
  }
  if (result.rank && result.rank <= 3) s.podiums = (s.podiums || 0) + 1;
  for (const [k, v] of Object.entries(result.counters || {})) {
    if (typeof v === 'number') s.counters[k] = (s.counters[k] || 0) + v;
  }
  const g = s.byGame[gameType] || { played: 0, won: 0, points: 0, bestScore: 0 };
  g.played += 1;
  if (won) g.won += 1;
  g.points += result.score || 0;
  g.bestScore = Math.max(g.bestScore, result.score || 0);
  s.byGame[gameType] = g;
  const b = result.best;
  if (b && b.votes > 0) {
    const share = (x) => (x.totalVotes ? x.votes / x.totalVotes : 0);
    if (!s.bestAnswer || b.votes > s.bestAnswer.votes || (b.votes === s.bestAnswer.votes && share(b) > share(s.bestAnswer))) {
      s.bestAnswer = { prompt: b.prompt, answer: b.answer, votes: b.votes, totalVotes: b.totalVotes, at: now };
    }
  }
  s.firstPlayed ||= now;
  s.lastPlayed = now;
  return s;
}

export function pickFreeColor(taken, preferred) {
  if (preferred && PLAYER_COLORS.includes(preferred) && !taken.has(preferred)) return preferred;
  return PLAYER_COLORS.find((c) => !taken.has(c)) || preferred || PLAYER_COLORS[0];
}
