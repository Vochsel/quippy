// Monty's AI quips for quip-style games (Zinger Duel, Callback Club): personal,
// pointed lines about the actual people and what they wrote tonight.
//
// While the room votes, one model call writes three versions of the line for
// a matchup (if A wins, if B wins, if it's a tie), so the reveal can twist the
// knife at the right person. A random comic angle each time + the last few
// quips (to dodge) keep them varied. Everything falls back to the stock lines.
import { pick, shuffle } from '../../core/util.js';
import { toneById } from '../../core/tones.js';

const ANGLES = [
  'roast the loser\'s answer specifically, quoting a word or two of it',
  'mock-sincere praise of the winner that turns into a jab',
  'call back to something one of them wrote earlier tonight',
  'their record tonight: point out a streak, a slump or a pattern',
  'the rivalry between these two people tonight',
  'what this answer reveals about the person who wrote it (their taste, judgement, life choices)',
  'accuse the room of voting for the wrong reason',
  'a very specific Australian comparison',
  'a fake statistic or official ruling about the answer',
  'Monty takes it personally',
  'a one-line dramatic eulogy for the losing answer',
  'pretend this result changes everything about the night',
];

const SAFE = 'Jabs are about what they wrote, how they play, their record tonight and their choices. Never about appearance, weight, age, race, religion, gender, sexuality, disability or health.';

function persona(ctx) {
  const t = toneById(ctx.content?.tone);
  return t.brief || 'Monty: dry, deadpan, faintly world-weary, quietly delighted by everyone\'s failures, secretly fond of them all.';
}

// What tonight looks like for one player, in a line the model can use.
function profile(game, id) {
  const s = game.s;
  const name = game.ctx.playerName(id);
  const ranked = Object.entries(s.scores || {}).sort((a, b) => b[1] - a[1]).map(([pid]) => pid);
  const t = s.tallies?.[id] || {};
  const past = [];
  for (const m of s.history || []) {
    if (!m.result || !m.authors.includes(id) || !m.answers[id]) continue;
    past.push(`"${m.answers[id].text}" (to "${m.prompt.text}", ${m.result.winner === id ? 'won' : m.result.winner ? 'lost' : 'drew'})`);
  }
  return `${name}: ${ranked.indexOf(id) + 1 || '?'} of ${ranked.length} on ${s.scores?.[id] || 0} pts; won ${t.matchupsWon || 0} of ${t.matchupsPlayed || 0} head-to-heads${t.shutouts ? `, ${t.shutouts} shutouts` : ''}${t.panics ? `, used the panic button ${t.panics}x` : ''}. Earlier tonight: ${past.slice(-3).join('; ') || 'nothing yet'}.`;
}

function rivalry(game, a, b) {
  const met = (game.s.history || []).filter((m) => m.result && m.authors.includes(a) && m.authors.includes(b));
  if (!met.length) return 'First time these two have gone head to head tonight.';
  return `They've met ${met.length}x tonight: ${met.map((m) => (m.result.winner ? `${game.ctx.playerName(m.result.winner)} won` : 'a draw')).join(', ')}.`;
}

function loreAbout(ctx, names) {
  const jokes = ctx.lore?.().jokes || [];
  const hits = jokes.filter((j) => names.some((n) => `${j.title} ${j.detail || ''}`.toLowerCase().includes(n.toLowerCase())));
  return hits.slice(0, 3).map((j) => `"${j.title}"`).join(', ');
}

function remember(game, lines) {
  const s = game.s;
  s.recentQuips = [...(s.recentQuips || []), ...lines].slice(-8);
}

// -> { [authorA]: line, [authorB]: line, tie: line } or null
export async function aiMatchupQuips(ctx, game, m) {
  if (!ctx.llm?.available()) return null;
  const [a, b] = m.order?.length ? m.order : m.authors;
  if (!m.answers[a] || !m.answers[b]) return null;
  const na = ctx.playerName(a); const nb = ctx.playerName(b);
  const lore = loreAbout(ctx, [na, nb]);
  const out = await ctx.llm.json({
    system: [
      `You are the voice of the host of a party comedy-writing game, reacting out loud right after a head-to-head vote. Persona: ${persona(ctx)} ${ctx.content?.meta?.llmHint || ''}`,
      'Write three alternative spoken lines, one for each possible result. Each is ONE short sentence, max 14 words: a quick jab, not a speech. Use first names. Be specific to these people and these answers: a generic line is a failure. Punchy, surprising, genuinely funny; a sharp personal jab is welcome.',
      SAFE,
      ctx.settings?.family ? 'Family mode: keep it clean, no innuendo.' : '',
      `Comic angle for this one: ${pick(ANGLES)}.`,
      game.s.recentQuips?.length ? `Do not reuse the structure or jokes of these recent lines: ${game.s.recentQuips.map((q) => `"${q}"`).join(' ')}` : '',
      'JSON: {"if_a_wins":"...","if_b_wins":"...","if_tie":"..."}',
    ].filter(Boolean).join('\n'),
    user: [
      `Round ${game.s.round}. Prompt: "${m.prompt.text}"`,
      `A) ${na} wrote: "${m.answers[a].text}"${m.answers[a].panic ? ' (hit the panic button)' : ''}`,
      `B) ${nb} wrote: "${m.answers[b].text}"${m.answers[b].panic ? ' (hit the panic button)' : ''}`,
      profile(game, a), profile(game, b), rivalry(game, a, b),
      lore ? `Running jokes about them from past nights: ${lore}` : '',
    ].filter(Boolean).join('\n'),
    maxTokens: 1500,
    timeoutMs: 18000,
  });
  const clean = (t) => (typeof t === 'string' && t.trim() ? t.trim().replace(/^["']|["']$/g, '').slice(0, 140) : null);
  const lines = { [a]: clean(out?.if_a_wins), [b]: clean(out?.if_b_wins), tie: clean(out?.if_tie) };
  if (!lines[a] && !lines[b]) return null;
  remember(game, shuffle(Object.values(lines).filter(Boolean)).slice(0, 2));
  return lines;
}

// A personal jab for the scoreboard after a round. -> string or null
export async function aiScoresQuip(ctx, game) {
  if (!ctx.llm?.available()) return null;
  const s = game.s;
  const ranked = Object.entries(s.scores || {}).sort((x, y) => y[1] - x[1]);
  if (ranked.length < 2) return null;
  const table = ranked.map(([id, pts], i) => {
    const before = s.roundStartScores?.[id] || 0;
    return `${i + 1}. ${ctx.playerName(id)} ${pts} pts (+${pts - before} this round)`;
  }).join('\n');
  const out = await ctx.llm.json({
    system: [
      `You are the voice of the host of a party comedy game announcing the scoreboard out loud. Persona: ${persona(ctx)} ${ctx.content?.meta?.llmHint || ''}`,
      'Write ONE spoken sentence (max 16 words) about the standings: name the leader and take one specific, funny shot at someone. Personal and pointed, not generic. Brevity is the joke.',
      SAFE,
      ctx.settings?.family ? 'Family mode: keep it clean.' : '',
      s.recentQuips?.length ? `Avoid repeating these recent lines: ${s.recentQuips.map((q) => `"${q}"`).join(' ')}` : '',
      'JSON: {"line":"..."}',
    ].filter(Boolean).join('\n'),
    user: `After round ${s.round}:\n${table}\n${ranked.slice(0, 4).map(([id]) => profile(game, id)).join('\n')}`,
    maxTokens: 800,
    timeoutMs: 15000,
  });
  const line = typeof out?.line === 'string' ? out.line.trim().slice(0, 150) : null;
  if (line) remember(game, [line]);
  return line;
}
