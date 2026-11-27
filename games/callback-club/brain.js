// The Callback Club "brain": writes prompts tailored to this crew, calls back
// to tonight's answers and the Lore Book, adapts to how the room is going, and
// feeds the host a one-liner for every matchup.
//
// Uses the configured language model (local Ollama / LM Studio, or the Vercel
// AI Gateway). If none is available, or a call fails, a template brain built
// from the locale's callback templates takes over, so the game always runs.
import { toneById } from '../../core/tones.js';
import { loreForPrompt } from '../../core/lore.js';
import { cleanText, fill, pick, shuffle } from '../../core/util.js';
import { bankProvider } from '../_quip/bank.js';

const MAX_PROMPT_CHARS = 140;

function topAnswers(game, n = 8) {
  const rows = [];
  for (const m of game.s.history) {
    if (!m.result) continue;
    for (const id of m.authors) {
      const a = m.answers[id];
      if (!a || a.panic) continue;
      rows.push({
        id, name: game.ctx.playerName(id), prompt: m.prompt.text, answer: a.text,
        votes: m.result.votes[id] || 0, total: m.result.total || 0, won: m.result.winner === id,
      });
    }
  }
  return rows.sort((x, y) => y.votes - x.votes || (y.won - x.won)).slice(0, n);
}

// Normalise for comparing prompts ("same joke again?").
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function earlierPrompts(game) {
  return [...game.s.history, ...game.s.matchups].map((m) => norm(m.prompt?.text)).filter(Boolean);
}

// A callback prompt mustn't just be an earlier prompt again (or contain it whole).
function repeatsEarlier(text, seen) {
  const t = norm(text);
  return seen.some((p) => p === t || (p.length > 20 && t.includes(p)) || (t.length > 20 && p.includes(t)));
}

function rosterNames(game) {
  return game.s.roster.filter((id) => !game.ctx.isBot(id)).map((id) => game.ctx.playerName(id));
}

function systemPrompt(ctx) {
  const meta = ctx.content.meta;
  return [
    `You write prompts for "Callback Club", a party comedy-writing game shown on a TV and played on phones. The host is ${meta.hostName || 'Monty'}, a dry, deadpan, faintly world-weary game-show host.`,
    'Two players secretly answer each prompt with a short funny phrase (under 80 characters), then the room votes for the funnier one.',
    'What makes a great prompt:',
    '- Short (under 100 characters) and open: it invites many different punchlines, never one obvious answer.',
    '- Concrete and vivid beats abstract. Specific places, objects and situations.',
    '- Personal prompts may name a player; teasing is fine, cruelty is not.',
    '- Never about appearance, weight, race, religion, sexuality, disability, health or anything genuinely hurtful.',
    '- Never acronyms, letter puzzles, rhymes or "fill in exactly N words" mechanics.',
    '- Callbacks should make sense to people who were in the room even if they half-forgot: quote the earlier answer briefly.',
    '- A callback must take the earlier moment somewhere NEW (a sequel, consequence, new setting, someone else\'s view). Never repeat or lightly reword an earlier prompt, and never make the prompt just the old answer restated. The callback should set up a fresh joke, not be the old one.',
    meta.llmHint || '',
    ctx.settings.family ? 'FAMILY MODE: keep everything suitable for kids. No innuendo, no drinking jokes.' : 'Cheeky innuendo is okay in moderation; nothing explicit.',
  ].filter(Boolean).join('\n');
}

function adaptiveNotes(sig) {
  const notes = [];
  if (sig.panicRate > 0.2 || sig.noAnswerRate > 0.15) notes.push('Players are struggling (lots of panic buttons / blank answers): make prompts simpler, more concrete and easier to riff on.');
  if (sig.avgAnswerLength && sig.avgAnswerLength < 18) notes.push('Answers are short and punchy: prompts that reward one-liners work well.');
  if (sig.shutoutRate > 0.4) notes.push('Lots of shutouts: the room has a clear taste — lean into the styles that won.');
  return notes.join(' ') || 'The room is going fine; keep variety high.';
}

async function aiRoundPrompts(ctx, game, round, count) {
  const names = rosterNames(game);
  const tonight = topAnswers(game, 10)
    .map((a) => `- ${a.name} answered "${a.prompt}" with "${a.answer}" (${a.votes}/${a.total} votes${a.won ? ', won' : ''})`).join('\n');
  const strategy = round === 1
    ? `Round 1 ("Tailor-made"): write ${count} prompts made for THIS group. About half should name one of the players (use their exact name). The rest should riff on the Lore Book's running jokes if there are any; otherwise invent prompts that suit the crew's taste. Make each one different in structure.`
    : `Round 2 ("Callbacks", double points): write ${count} prompts. At least ${Math.ceil(count / 2)} must call back to tonight's answers — quote or reference them so the room remembers (e.g. a sequel, a consequence, a product launch, a court case). Prefer callbacks to the answers that got the most votes. The rest can name players or use the Lore Book.`;
  const out = await ctx.llm.json({
    system: systemPrompt(ctx),
    user: [
      `Players: ${names.join(', ') || '(bots only)'}`,
      '',
      'Lore Book (running jokes from previous sessions):',
      loreForPrompt(ctx.lore()),
      '',
      round > 1 ? `Tonight so far:\n${tonight || '(nothing yet)'}` : '',
      `How the room is going: ${adaptiveNotes(game.signals())}`,
      '',
      strategy,
      'JSON shape: {"prompts":[{"text":"the prompt","about":"player name or empty","callback":"what it calls back to, <=8 words, or empty"}]}',
    ].filter((x) => x !== '').join('\n'),
    maxTokens: 5000,
  });
  const seen = earlierPrompts(game);
  const prompts = (out?.prompts || [])
    .filter((p) => p && typeof p.text === 'string' && p.text.trim().length > 8)
    .map((p) => ({ text: cleanText(p.text, MAX_PROMPT_CHARS), callback: cleanText(p.callback || '', 60) || null }))
    .filter((p) => !repeatsEarlier(p.text, seen));
  if (!prompts.length) throw new Error('model returned no prompts');
  return prompts;
}

async function aiFinalPrompt(ctx, game) {
  const tonight = topAnswers(game, 12)
    .map((a) => `- ${a.name}: "${a.answer}" (to "${a.prompt}", ${a.votes} votes)`).join('\n');
  const out = await ctx.llm.json({
    system: systemPrompt(ctx),
    user: [
      `Players: ${rosterNames(game).join(', ')}`,
      'Lore Book:', loreForPrompt(ctx.lore(), 6), '',
      `Tonight's best answers:\n${tonight || '(none)'}`, '',
      'Write the prompt for "The Grand Callback", the final round where EVERY player answers the same prompt. It should tie back to the biggest running joke of the night (quote it briefly) and be wide open so everyone can take it somewhere different.',
      'JSON shape: {"text":"the prompt","callback":"what it calls back to"}',
    ].join('\n'),
    maxTokens: 2500,
  });
  if (!out?.text) throw new Error('model returned no final prompt');
  if (repeatsEarlier(out.text, earlierPrompts(game))) throw new Error('final prompt repeated an earlier one');
  return { text: cleanText(out.text, MAX_PROMPT_CHARS), callback: cleanText(out.callback || '', 60) || null };
}

async function aiQuip(ctx, game, m) {
  const [a, b] = m.order.length ? m.order : m.authors;
  const out = await ctx.llm.json({
    system: [
      `You are ${ctx.content.meta.hostName || 'Monty'}, host of a party comedy game: dry, deadpan, faintly world-weary, secretly fond of everyone. ${ctx.content.meta.llmHint || ''}`,
      // The room's host persona (core/tones.js), if not the usual Monty.
      toneById(ctx.content.tone).brief ? `Tonight's persona, which overrides the above: ${toneById(ctx.content.tone).brief}` : '',
      'Write ONE spoken line (max 22 words) reacting to this head-to-head matchup. It is read aloud after the votes are revealed, so it must work whoever wins. You may mention the players by first name. Never be cruel about appearance, race, religion, sexuality, disability or health.',
      'JSON shape: {"line":"..."}',
    ].join('\n'),
    user: [
      `Prompt: ${m.prompt.text}`,
      `${ctx.playerName(a)} wrote: "${m.answers[a]?.text}"`,
      `${ctx.playerName(b)} wrote: "${m.answers[b]?.text}"`,
    ].join('\n'),
    maxTokens: 1500,
    timeoutMs: 15000,
  });
  return typeof out?.line === 'string' ? out.line : null;
}

// ------------------------------------------------------------- template brain
function builtinRoundPrompts(ctx, game, round, count, bank) {
  const used = ctx.usedPrompts;
  const templates = ctx.content.callbackTemplates();
  const out = [];
  if (round === 1) {
    const jokes = (ctx.lore().jokes || []).filter((j) => j.title).sort((x, y) => y.heat - x.heat).slice(0, 3);
    const loreTemplates = templates.filter((t) => t.includes('{joke}'));
    for (const j of jokes) {
      if (out.length >= Math.floor(count / 2) || !loreTemplates.length) break;
      out.push({ text: fill(pick(loreTemplates), { joke: j.title, player: j.players?.[0] || '{player}' }), callback: j.title });
    }
    out.push(...ctx.content.pickPersonal(Math.max(0, Math.ceil(count / 2) - out.length), used));
  } else {
    const answerTemplates = templates.filter((t) => t.includes('{answer}') && !t.includes('{joke}'));
    for (const a of shuffle(topAnswers(game, count))) {
      if (out.length >= Math.ceil(count / 2) || !answerTemplates.length) break;
      out.push({ text: fill(pick(answerTemplates), { answer: a.answer, player: a.name, prompt: a.prompt }), callback: a.answer });
    }
    out.push(...ctx.content.pickPersonal(1, used));
  }
  const rest = bank.roundPrompts(game, round, Math.max(0, count - out.length));
  return shuffle([...out, ...rest]).slice(0, count);
}

function builtinFinalPrompt(ctx, game, bank) {
  const best = topAnswers(game, 1)[0];
  const templates = ctx.content.callbackTemplates().filter((t) => t.includes('{answer}') && !t.includes('{joke}'));
  if (best && templates.length) {
    return { text: fill(pick(templates), { answer: best.answer, player: best.name, prompt: best.prompt }), callback: best.answer };
  }
  return bank.finalPrompt(game);
}

export function callbackBrain(ctx) {
  const bank = bankProvider(ctx);
  const ai = () => ctx.llm?.available();
  return {
    roundTitle(round) {
      return ctx.line(`cbRoundTitle${round}`) || null;
    },
    loadingText(round) {
      return ai() ? ctx.line('cbLoadingAi', { round }) : ctx.line('cbLoadingBuiltin', { round });
    },
    introLine() {
      const jokes = (ctx.lore().jokes || []).sort((x, y) => y.heat - x.heat);
      if (jokes.length) return ctx.line('cbIntroWithLore', { joke: jokes[0].title, count: jokes.length });
      return ctx.line('cbIntroFresh', {});
    },
    introCard() {
      const lore = ctx.lore();
      return {
        brain: ai() ? `${ctx.llm.label}${ctx.llm.model ? ` · ${ctx.llm.model}` : ''}` : 'Built-in brain',
        jokes: (lore.jokes || []).sort((x, y) => y.heat - x.heat).slice(0, 4).map((j) => ({ title: j.title, detail: j.detail, heat: j.heat })),
        taste: lore.taste || '',
      };
    },
    async roundPrompts(game, round, count) {
      if (ai()) {
        try {
          const prompts = await aiRoundPrompts(ctx, game, round, count);
          if (prompts.length < count) prompts.push(...builtinRoundPrompts(ctx, game, round, count - prompts.length, bank));
          return prompts;
        } catch (e) {
          ctx.log('callback-club: AI prompts failed, using built-in brain:', e.message);
        }
      }
      return builtinRoundPrompts(ctx, game, round, count, bank);
    },
    async finalPrompt(game) {
      if (ai()) {
        try { return await aiFinalPrompt(ctx, game); } catch (e) { ctx.log('callback-club: AI final failed:', e.message); }
      }
      return builtinFinalPrompt(ctx, game, bank);
    },
    async quip(game, m) {
      if (!ai()) return null;
      try { return await aiQuip(ctx, game, m); } catch { return null; }
    },
  };
}
