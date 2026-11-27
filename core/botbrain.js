// AI bot players. With a language model available, bots write real answers
// (each with its own comic style) and vote with a judge's taste, so one person
// can test or play a whole game alone. One model call per batch keeps it cheap;
// any failure falls back to the old behaviour (panic lines, coin-flip votes).

const STYLES = [
  'dry, deadpan understatement',
  'chaotic gremlin energy, absurd non-sequiturs',
  'groan-worthy puns and dad jokes',
  'painfully literal, takes everything at face value',
  'oversharing auntie with oddly specific details',
  'wholesome but accidentally dark',
  'smug know-it-all who is confidently wrong',
  'tired tradie, blunt and practical',
  'dramatic soap-opera villain',
  'nan who has seen it all and fears nothing',
];

function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

export function botStyle(name) {
  return STYLES[hash(name) % STYLES.length];
}

function flavour(ctx) {
  const meta = ctx.content?.meta || {};
  return [
    meta.llmHint || '',
    ctx.settings?.family ? 'Keep it family friendly: no swearing, nothing sexual.' : 'Cheeky is fine; nothing hateful or cruel about real groups.',
  ].filter(Boolean).join(' ');
}

const TIMEOUT_MS = 25000;

// items: [{ key, prompt, name }] -> { [key]: answer text }
export async function botAnswers(ctx, items, maxChars = 80) {
  if (!items.length || !ctx.llm?.available()) return {};
  const limit = Math.min(maxChars, 90);
  const out = await ctx.llm.json({
    system: [
      'You write answers for bot players in a party comedy game: each prompt gets a short, funny answer that a quick-witted human might type.',
      `Answers are under ${limit} characters, no quotation marks, no emoji, no hashtags. Write in the given player's comic style.`,
      'Surprise beats obvious. Specific beats generic. Never explain the joke.',
      flavour(ctx),
      'JSON shape: {"answers":{"<key>":"answer", ...}}',
    ].join('\n'),
    user: JSON.stringify(items.map((i) => ({ key: i.key, prompt: i.prompt, player: i.name, style: botStyle(i.name) }))),
    maxTokens: 300 + items.length * 60,
    timeoutMs: TIMEOUT_MS,
  });
  const answers = out?.answers && typeof out.answers === 'object' ? out.answers : {};
  const result = {};
  for (const i of items) {
    const text = typeof answers[i.key] === 'string' ? answers[i.key].trim().slice(0, limit) : '';
    if (text) result[i.key] = text;
  }
  return result;
}

// items: [{ key, prompt, options: [text, ...] }] -> { [key]: [indices, funniest first] }
export async function botJudge(ctx, items) {
  if (!items.length || !ctx.llm?.available()) return {};
  const out = await ctx.llm.json({
    system: [
      'You judge a party comedy game. For each prompt, rank the answers from funniest to least funny, like a fun, generous crowd would.',
      flavour(ctx),
      'JSON shape: {"rankings":{"<key>":[index, index, ...]}} using the 0-based answer indices.',
    ].join('\n'),
    user: JSON.stringify(items.map((i) => ({ key: i.key, prompt: i.prompt, answers: i.options }))),
    maxTokens: 200 + items.length * 30,
    timeoutMs: TIMEOUT_MS,
  });
  const rankings = out?.rankings && typeof out.rankings === 'object' ? out.rankings : {};
  const result = {};
  for (const i of items) {
    const r = Array.isArray(rankings[i.key]) ? rankings[i.key].map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < i.options.length) : [];
    const seen = [...new Set(r)];
    for (let n = 0; n < i.options.length; n++) if (!seen.includes(n)) seen.push(n);
    result[i.key] = seen;
  }
  return result;
}
