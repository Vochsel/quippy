// The Lore Book: a crew's running jokes, remembered across games, sessions and
// server restarts. After every game the lore is updated — by the language
// model when one is available, otherwise by a simple heuristic that promotes
// the most-voted answers. AI-flavoured games read the lore back to write
// callback prompts ("Remember when Bazza said...").
import { hash } from './util.js';

const MAX_JOKES = 14;

export function emptyLore() {
  return { jokes: [], taste: '', gamesSeen: 0, updatedAt: null };
}

export function loreSummary(lore, n = 6) {
  const l = { ...emptyLore(), ...(lore || {}) };
  return {
    jokes: [...l.jokes].sort((a, b) => b.heat - a.heat).slice(0, n)
      .map(({ title, detail, players, heat, quote }) => ({ title, detail, players, heat, quote })),
    taste: l.taste,
    gamesSeen: l.gamesSeen,
  };
}

// Text block handed to language models.
export function loreForPrompt(lore, n = 10) {
  const l = { ...emptyLore(), ...(lore || {}) };
  if (!l.jokes.length && !l.taste) return 'No lore yet: this is a fresh crew.';
  const lines = [...l.jokes].sort((a, b) => b.heat - a.heat).slice(0, n)
    .map((j) => `- ${j.title}${j.detail ? ` — ${j.detail}` : ''}${j.players?.length ? ` (${j.players.join(', ')})` : ''} [heat ${j.heat}]`);
  if (l.taste) lines.push(`Crew taste: ${l.taste}`);
  return lines.join('\n');
}

export function heuristicLoreUpdate(lore, answers, now = Date.now()) {
  const l = { ...emptyLore(), ...(lore || {}) };
  const jokes = l.jokes.map((j) => ({ ...j, heat: j.heat - 1 }));
  const top = [...answers]
    .filter((a) => a.votes > 0 && a.answer)
    .sort((a, b) => (b.votes / Math.max(1, b.totalVotes)) - (a.votes / Math.max(1, a.totalVotes)) || b.votes - a.votes)
    .slice(0, 3);
  for (const a of top) {
    const id = hash(a.answer.toLowerCase());
    const existing = jokes.find((j) => j.id === id);
    if (existing) {
      existing.heat = Math.min(10, existing.heat + 3);
      existing.lastSeen = now;
    } else {
      jokes.push({
        id, title: a.answer, detail: `${a.playerName} on "${a.prompt}"`, players: [a.playerName],
        heat: Math.min(10, 4 + a.votes), quote: a.answer, firstSeen: now, lastSeen: now,
      });
    }
  }
  return {
    ...l,
    jokes: jokes.filter((j) => j.heat > 0).sort((a, b) => b.heat - a.heat).slice(0, MAX_JOKES),
    gamesSeen: (l.gamesSeen || 0) + 1,
    updatedAt: now,
  };
}

export async function aiLoreUpdate(llm, { lore, answers, players, localeHint }) {
  const top = [...answers].sort((a, b) => b.votes - a.votes).slice(0, 30)
    .map((a) => `- ${a.playerName} answered "${a.prompt}" with "${a.answer}" (${a.votes}/${a.totalVotes} votes)`).join('\n');
  const out = await llm.json({
    system: [
      'You are the archivist for a party comedy game. You keep a "Lore Book" of a friend group\'s running jokes so the game can call back to them in future sessions.',
      'A running joke is a memorable answer, a recurring theme, a character someone invented, or a bit that got big laughs (lots of votes).',
      'Keep jokes short and quotable. Never record anything cruel about appearance, race, religion, sexuality, disability or health.',
      localeHint || '',
      'JSON shape: {"jokes":[{"title":"<=8 words","detail":"<=20 words of context","players":["names"],"heat":1-10,"quote":"short quote or empty"}],"taste":"one sentence on what this crew finds funny"}',
    ].join('\n'),
    user: [
      `Players tonight: ${players.join(', ')}`,
      'Current Lore Book:',
      loreForPrompt(lore, MAX_JOKES),
      '',
      'Tonight\'s answers (most-voted first):',
      top || '(none)',
      '',
      `Return the updated Lore Book with at most ${MAX_JOKES} jokes: keep strong old jokes (raise heat if they came back tonight, lower it slightly if not), merge duplicates, and add the best new bits from tonight.`,
    ].join('\n'),
    maxTokens: 6000,
  });
  if (!Array.isArray(out?.jokes)) throw new Error('bad lore shape');
  const now = Date.now();
  const prev = new Map((lore?.jokes || []).map((j) => [j.id, j]));
  const jokes = out.jokes
    .filter((j) => j && typeof j.title === 'string' && j.title.trim())
    .slice(0, MAX_JOKES)
    .map((j) => {
      const id = hash(j.title.toLowerCase().trim());
      return {
        id,
        title: String(j.title).slice(0, 80),
        detail: String(j.detail || '').slice(0, 160),
        players: Array.isArray(j.players) ? j.players.map(String).slice(0, 4) : [],
        heat: Math.max(1, Math.min(10, Math.round(Number(j.heat) || 5))),
        quote: String(j.quote || '').slice(0, 100),
        firstSeen: prev.get(id)?.firstSeen || now,
        lastSeen: now,
      };
    });
  return {
    jokes,
    taste: String(out.taste || lore?.taste || '').slice(0, 200),
    gamesSeen: (lore?.gamesSeen || 0) + 1,
    updatedAt: now,
  };
}

export async function updateCrewLore({ store, llm, crewId, answers, players, localeHint, log }) {
  const crew = await store.getCrew(crewId);
  const lore = { ...emptyLore(), ...(crew?.lore || {}) };
  let next;
  if (llm?.available() && answers.length) {
    try {
      next = await aiLoreUpdate(llm, { lore, answers, players, localeHint });
    } catch (e) {
      log?.('lore: model update failed, using heuristic:', e.message);
    }
  }
  next ||= heuristicLoreUpdate(lore, answers);
  await store.saveCrewLore(crewId, next);
  return next;
}
