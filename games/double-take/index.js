// Double Take: everyone secretly prompts a picture of someone in the room; the
// robot paints them all; then, one picture at a time, the room picks which of
// four captions really made it.
//
//   1. Everyone takes (or keeps) a selfie: the robot paints people from it.
//   2. Write: every player writes ONE secret picture prompt starring someone
//      in the room ("Ben as a Lego minifig stuck in a Bunnings queue").
//   3. Every prompt is painted (a few at a time). Anyone named in a prompt is
//      painted from their selfie. Meanwhile three decoy captions are written
//      for each prompt (one batched model call, or bank briefs as a fallback).
//   4. One picture at a time: the TV shows the picture and four captions; all
//      but the author tap the one they think is real. +500 for a correct
//      guess, +250 to the author per correct guesser; the second half counts
//      double.
//
// A picture that fails is retried once, then becomes a free "redacted sketch",
// so the game never stalls. Images live in the media store; state only keeps
// media keys. Rooms without an image model, and bot-only games, get sketches
// (no paid calls). At most MAX_AI_IMAGES paid generations per game.
import { cleanText, fill, shuffle, uid } from '../../core/util.js';
import { placeholderSvg, IMAGE_EXT } from '../../core/images.js';

// Names as they go into captions and image prompts (no bot emoji).
const plain = (name) => String(name || '').replace(/\s*🤖/gu, '').trim() || 'Someone';
const firstName = (name) => plain(name).split(/\s+/)[0];
const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MAX_CHARS = 160;
const DECOYS = 3;
const POINTS = 500; // a correct guess
const AUTHOR_POINTS = 250; // to the author, per correct guesser
const MAX_AI_IMAGES = 12; // cost guard: paid generations per game (incl. retries)
const MAX_REFS = 6; // selfies sent with one picture
const CONCURRENCY = 4;
const SUGGESTIONS = 6;
const INTRO_MS = 10000;
const SELFIE_MS = 45000;
const SELFIE_DONE_MS = 2500; // everyone's confirmed: a beat, then go
const WRITE_MS = 75000;
const WRITE_DONE_MS = 2000; // everyone's sent theirs: a beat, then go
const PAINT_MIN_MS = 3500; // picture title card, even when it's ready
const PAINT_WAIT_MS = 60000; // then sketch it if it's still not there
const GUESS_MS = 20000;
const GUESS_DONE_MS = 2500; // everyone has picked: a beat to change their minds
const REVEAL_MS = 10000;
const SCORES_MS = 9000;
const GAME_OVER_MS = 40000;
const DECOY_TIMEOUT_MS = 30000;
const TIMED = ['selfie', 'write', 'guess'];
const PHASE_TIMERS = ['intro', 'selfie', 'write', 'guess', 'reveal', 'scores', 'gameOver'];

const zero = () => ({
  answersWritten: 0, picturesGuessed: 0, correctPicks: 0, fooledBy: 0, blanks: 0,
  votesCast: 0, answerMs: 0, answerTimed: 0, spottedBy: 0, peopleFooled: 0, starredIn: 0,
});

const meta = {
  id: 'double-take',
  name: 'Double Take',
  tagline: 'Prompt a picture of your mates. Everyone guesses which caption made it.',
  minPlayers: 3,
  maxPlayers: 16,
  accent: '#a98bff',
  client: 'double-take',
  usesAi: true,
};

export default {
  ...meta,
  create: (ctx) => new DoubleTake(ctx, null),
  restore: (ctx, state) => new DoubleTake(ctx, state),
};

const joinNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

class DoubleTake {
  constructor(ctx, state) {
    this.ctx = ctx;
    this.inflight = new Set(); // tokens of generations running in this process (lost on restart)
    this.decoyToken = null; // the decoy job running in this process
    this.dead = false;
    this.s = state || this.#fresh();
  }

  #fresh() {
    const roster = this.ctx.roster();
    return {
      phase: 'intro', roster, deadline: null, timerMs: null,
      scores: Object.fromEntries(roster.map((id) => [id, 0])),
      roundStartScores: Object.fromEntries(roster.map((id) => [id, 0])),
      tallies: Object.fromEntries(roster.map((id) => [id, zero()])),
      selfies: {}, // pid -> true once confirmed
      // SECRET until each reveal: pid -> { text, auto }, plus unsent drafts.
      prompts: {}, drafts: {}, suggest: {},
      pics: [], idx: 0, aiSpent: 0, sketchOnly: false, minUntil: 0,
      decoyState: 'idle', // idle | pending | done
      awards: [], finished: false,
    };
  }

  serialize() { return this.s; }
  sceneKey() { return `${this.s.phase}|${this.s.idx}`; }

  // ------------------------------------------------------------- lifecycle
  start() {
    this.ctx.music('intro');
    this.#phase('intro', INTRO_MS);
    this.ctx.sayLine('dtWelcome', { game: meta.name });
  }

  resume() {
    const s = this.s;
    const d = this.ctx.timerDeadline?.(s.phase);
    if (d) s.deadline = d;
    // Generations in flight died with the old process: queue them again.
    for (const p of s.pics) if (p.status === 'painting') { p.status = 'queued'; p.token = null; }
    this.inflight.clear();
    if (s.decoyState === 'pending') this.#writeDecoys();
    this.#pump();
    if (s.phase === 'write') this.#botsWrite();
    if (s.phase === 'painting') this.#checkReady();
    if (s.phase === 'guess') { this.#botsGuess(); this.#authorTick(); }
  }

  onTimer(name) {
    if (PHASE_TIMERS.includes(name) && this.s.phase !== name) return undefined; // stale
    switch (name) {
      case 'intro': return this.#startSelfies();
      case 'selfie': return this.#endSelfies();
      case 'write': return this.#endWrite();
      case 'paintMin': return this.#checkReady();
      case 'paint': return this.#paintTimeout();
      case 'guess': return this.#reveal();
      case 'reveal': return this.#afterReveal();
      case 'scores': return this.s.idx >= this.s.pics.length ? this.#gameOver() : this.#startPicture(this.s.idx);
      case 'gameOver': return this.#finish();
      default: return undefined;
    }
  }

  onContinue() {
    const p = this.s.phase;
    if (p === 'gameOver') this.#finish();
    else if (['intro', 'selfie', 'reveal', 'scores'].includes(p)) { this.ctx.clearTimer(p); this.onTimer(p); }
  }

  onHostAction(p) {
    if (p?.type === 'skip') this.onContinue();
  }

  onAction(pid, p) {
    if (!p || typeof p !== 'object') return;
    const s = this.s;
    if (p.type === 'selfieDone' && s.phase === 'selfie' && s.roster.includes(pid) && !s.selfies[pid]) {
      s.selfies[pid] = true;
      this.ctx.sfx('select');
      if (this.#humans().every((id) => s.selfies[id])) this.#selfiesAllDone();
      this.ctx.update();
    } else if (p.type === 'prompt' && s.phase === 'write') {
      this.#submit(pid, p.text);
    } else if (p.type === 'draft' && s.phase === 'write' && s.roster.includes(pid) && !s.prompts[pid]) {
      // Kept quietly (no broadcast): sent for them if the timer runs out.
      s.drafts[pid] = cleanText(p.text, MAX_CHARS);
    } else if (p.type === 'pick' && s.phase === 'guess') {
      this.#setPick(pid, p.picId, p.choice);
    }
  }

  #phase(name, ms = 0, timerName = name) {
    this.s.phase = name;
    this.s.deadline = ms ? this.ctx.setTimer(timerName, ms) : null;
    this.s.timerMs = ms || null;
    this.ctx.update();
    this.ctx.checkpoint?.();
  }

  #humans() { return this.s.roster.filter((id) => !this.ctx.isBot(id)); }

  // --------------------------------------------------------------- selfies
  #startSelfies() {
    const s = this.s;
    // Faces are remembered: anyone with a saved selfie is already done (they
    // can still retake), so the step only waits on people without one.
    for (const id of s.roster) if (this.ctx.isBot(id) || this.ctx.hasPhoto?.(id)) s.selfies[id] = true;
    const needed = this.#humans().filter((id) => !s.selfies[id]);
    if (!needed.length) return this.#startWrite(); // everyone's got a face on file
    this.#phase('selfie', SELFIE_MS);
    this.ctx.music('writing');
    this.ctx.sayLine('dtSelfie', {});
    this.ctx.buzz(needed, [80, 60, 80]);
    return undefined;
  }

  #selfiesAllDone() {
    const s = this.s;
    const left = (s.deadline || 0) - Date.now();
    if (left > SELFIE_DONE_MS) s.deadline = this.ctx.setTimer('selfie', SELFIE_DONE_MS);
  }

  #endSelfies() {
    if (this.s.phase !== 'selfie') return;
    this.ctx.clearTimer('selfie');
    this.#startWrite();
  }

  // ----------------------------------------------------------------- write
  // Who a prompt stars: roster players named in it (whole word, case-
  // insensitive, full name or first name), in order of appearance.
  #namesIn(text) {
    const hits = [];
    for (const id of this.s.roster) {
      const full = plain(this.ctx.playerName(id));
      let at = -1;
      for (const v of new Set([full, full.split(/\s+/)[0]])) {
        if (v.length < 2) continue;
        const m = new RegExp(`(?<![\\p{L}\\p{N}])${esc(v)}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
        if (m && (at < 0 || m.index < at)) at = m.index;
      }
      if (at >= 0) hits.push({ id, at });
    }
    return hits.sort((a, b) => a.at - b.at).map((x) => x.id);
  }

  // Picture briefs from the bank with real names in. `stars` (if given) are
  // used first, so decoys star the same faces as the real prompt.
  #bankBriefs(n, stars = [], avoid = new Set()) {
    const ctx = this.ctx;
    const c = ctx.content;
    let pool = c.pickPeople?.(Math.max(n * 3, 12), ctx.usedPrompts) || [];
    if (pool.length < n) {
      // A pack without people briefs: borrow visual briefs and star someone in them.
      pool = [...pool, ...(c.pickPictures?.(n * 3, ctx.usedPrompts) || c.pickPrompts(n * 3, ctx.usedPrompts))
        .map((p) => ({ ...p, text: `{player} in: ${p.text}` }))];
    }
    // First names, like the name chips on the phones, so fakes read like the real ones.
    const names = (ids) => ids.map((id) => firstName(ctx.playerName(id)));
    const out = [];
    const seen = new Set(avoid);
    for (let tries = 0; out.length < n && tries < n * 8 && pool.length; tries++) {
      const b = pool[tries % pool.length];
      const lead = stars.length ? stars[(out.length + tries) % stars.length] : this.s.roster[Math.floor(Math.random() * this.s.roster.length)];
      const others = shuffle(this.s.roster.filter((id) => id !== lead));
      const second = stars.find((id) => id !== lead) || others[0] || lead;
      const [p1, p2] = names([lead, Math.random() < 0.5 ? second : (others[0] || second)]);
      const text = cleanText(fill(b.text, { player: p1, player2: p2 }), MAX_CHARS);
      if (!text || seen.has(norm(text))) continue;
      seen.add(norm(text));
      out.push({ text, key: b.key || null });
    }
    return out;
  }

  #startWrite() {
    const s = this.s;
    this.#syncRoster();
    s.prompts = {};
    s.drafts = {};
    // A few starters per player (the 💡 button cycles through them).
    s.suggest = Object.fromEntries(s.roster.map((id) => [id, this.#bankBriefs(SUGGESTIONS).map((b) => b.text)]));
    this.#phase('write', WRITE_MS);
    this.ctx.music('writing');
    this.ctx.sayLine('dtWrite', {});
    this.ctx.buzz(this.#humans(), [40, 30, 40]);
    this.#botsWrite();
    this.#checkWriteDone();
  }

  #submit(pid, raw) {
    const s = this.s;
    if (!s.roster.includes(pid) || s.prompts[pid]) return;
    const text = cleanText(raw, MAX_CHARS);
    if (text.length < 3) return;
    s.prompts[pid] = { text, auto: false };
    delete s.drafts[pid];
    this.ctx.sfx('submit');
    this.#checkWriteDone();
    this.ctx.update();
  }

  #checkWriteDone() {
    const s = this.s;
    if (s.phase !== 'write') return;
    if (!this.#humans().every((id) => s.prompts[id])) return;
    const left = (s.deadline || 0) - Date.now();
    if (left > WRITE_DONE_MS) s.deadline = this.ctx.setTimer('write', WRITE_DONE_MS);
  }

  #endWrite() {
    const s = this.s;
    if (s.phase !== 'write') return undefined;
    this.ctx.clearTimer('write');
    const used = [];
    // Anyone who didn't send: their draft if they had one, else a bank brief.
    for (const id of s.roster) {
      if (s.prompts[id]) continue;
      const draft = cleanText(s.drafts[id], MAX_CHARS);
      if (draft.length >= 3) { s.prompts[id] = { text: draft, auto: false }; continue; }
      const b = s.suggest[id]?.[0] ? { text: s.suggest[id][0] } : this.#bankBriefs(1)[0];
      if (b) s.prompts[id] = { text: b.text, auto: !this.ctx.isBot(id) };
      if (!this.ctx.isBot(id)) s.tallies[id].blanks += 1;
    }
    s.drafts = {};
    // Two people can't share one caption: a repeat gets a bank brief instead.
    const seen = new Set();
    for (const id of shuffle(s.roster)) {
      const pr = s.prompts[id];
      if (!pr) continue;
      if (seen.has(norm(pr.text))) {
        const b = this.#bankBriefs(1, [], seen)[0];
        if (b) { pr.text = b.text; used.push(b.key); } else { delete s.prompts[id]; continue; }
      }
      seen.add(norm(pr.text));
    }
    const authors = shuffle(s.roster.filter((id) => s.prompts[id]));
    const half = Math.ceil(authors.length / 2);
    s.pics = authors.map((id, i) => ({
      id: `p${i + 1}`, n: i + 1, mult: i + 1 > half ? 2 : 1,
      author: id, text: s.prompts[id].text, auto: !!s.prompts[id].auto, stars: this.#namesIn(s.prompts[id].text),
      status: 'queued', key: null, tries: 0, token: null, sketch: false, ai: false,
      options: null, real: null, // SECRET until the reveal: options[real] is the author's prompt
      picks: {}, pickMs: {}, startedAt: null, authorTickAt: null, result: null, skipped: false,
    }));
    for (const p of s.pics) {
      const t = s.tallies[p.author];
      if (t && !p.auto) t.answersWritten += 1;
      for (const id of p.stars) if (s.tallies[id]) s.tallies[id].starredIn += 1;
    }
    s.prompts = {};
    s.suggest = {};
    if (used.length) this.ctx.markPromptsUsed(used.filter(Boolean));
    if (!s.pics.length) return this.#gameOver();
    s.sketchOnly = !this.ctx.images?.available() || !this.#humans().length;
    this.ctx.sayLine(s.sketchOnly ? 'dtPaintingSketch' : 'dtPainting', {});
    s.decoyState = 'pending';
    this.#writeDecoys();
    this.#pump();
    return this.#startPicture(0);
  }

  // ---------------------------------------------------------------- decoys
  #writeDecoys() {
    const s = this.s;
    if (s.decoyState !== 'pending') return;
    const token = uid('d');
    this.decoyToken = token;
    const useAi = !!this.ctx.llm?.available?.() && this.#humans().length > 0;
    const job = useAi ? this.#aiDecoys() : Promise.resolve({});
    job.catch((e) => { this.ctx.log('double-take: decoys failed:', String(e?.message || e)); return {}; })
      .then((got) => this.#setDecoys(token, got || {}));
  }

  // One model call for every picture. -> { [picId]: [text, ...] }
  async #aiDecoys() {
    const s = this.s;
    const ctx = this.ctx;
    const people = s.roster.map((id) => firstName(ctx.playerName(id)));
    const out = await ctx.llm.json({
      system: [
        'You write decoy captions for a party guessing game. Each player secretly wrote a short prompt for an AI picture starring people in the room. The TV shows each picture with four captions: the real prompt plus three decoys. Players try to spot the real one.',
        `For each real prompt write exactly ${DECOYS} decoys that could plausibly have made a similar picture: the same style, tone, length and level of detail as the real one, written the way a person at a party would type it. Every decoy stars one or more of the people in the room, named the way the real prompts name them (usually first names), mostly the same people as the real prompt.`,
        'Make them plausible enough to fool people: similar setting or vibe but a different specific scene. Never just reword the real prompt, never copy any other real prompt, and no two decoys alike.',
        `Each decoy under ${MAX_CHARS - 20} characters. No quotation marks, no emoji, no hashtags.`,
        ctx.content?.meta?.llmHint || '',
        ctx.settings?.family ? 'Family mode: keep it clean.' : '',
        'JSON shape: {"decoys":{"<id>":["...","...","..."], ...}}',
      ].filter(Boolean).join('\n'),
      user: JSON.stringify({ people, prompts: s.pics.map((p) => ({ id: p.id, prompt: p.text })) }),
      maxTokens: 400 + s.pics.length * 220,
      timeoutMs: DECOY_TIMEOUT_MS,
    });
    return out?.decoys && typeof out.decoys === 'object' ? out.decoys : {};
  }

  #setDecoys(token, got) {
    const s = this.s;
    if (this.dead || token !== this.decoyToken || s.decoyState !== 'pending') return;
    this.decoyToken = null;
    const reals = new Set(s.pics.map((p) => norm(p.text)));
    const used = [];
    for (const pic of s.pics) {
      const seen = new Set(reals);
      const decoys = [];
      for (const raw of Array.isArray(got[pic.id]) ? got[pic.id] : []) {
        if (typeof raw !== 'string' || decoys.length >= DECOYS) continue;
        const text = cleanText(raw.replace(/^["'“]+|["'”]+$/g, ''), MAX_CHARS + 40);
        if (text.length < 8 || text.length >= MAX_CHARS || seen.has(norm(text)) || !this.#namesIn(text).length) continue;
        seen.add(norm(text));
        decoys.push(text);
      }
      if (decoys.length < DECOYS) {
        for (const b of this.#bankBriefs(DECOYS - decoys.length, pic.stars, seen)) {
          seen.add(norm(b.text));
          decoys.push(b.text);
          used.push(b.key);
        }
      }
      const opts = shuffle([{ text: pic.text, real: true }, ...decoys.slice(0, DECOYS).map((text) => ({ text, real: false }))]);
      pic.options = opts.map((o) => o.text);
      pic.real = opts.findIndex((o) => o.real);
    }
    s.decoyState = 'done';
    if (used.some(Boolean)) this.ctx.markPromptsUsed(used.filter(Boolean));
    this.ctx.checkpoint?.();
    this.#checkReady();
    this.ctx.update();
  }

  // -------------------------------------------------------------- painting
  // Start queued pictures (current one first), a few at a time.
  #pump() {
    const s = this.s;
    if (this.dead) return;
    for (const p of s.pics.slice(s.idx)) {
      if (this.inflight.size >= CONCURRENCY) return;
      if (p.skipped || p.result) continue;
      if (p.status === 'queued') this.#paintPic(p);
    }
  }

  #paintPic(pic) {
    const s = this.s;
    const token = uid('j');
    // Bots' prompts only get a paid picture if every person's can still have one.
    const humansWaiting = s.pics.filter((p) => p !== pic && !p.tries && !p.sketch && !this.ctx.isBot(p.author)).length;
    const useAi = !s.sketchOnly && !pic.sketch && s.aiSpent < MAX_AI_IMAGES
      && (!this.ctx.isBot(pic.author) || s.aiSpent + humansWaiting < MAX_AI_IMAGES);
    if (useAi) s.aiSpent += 1;
    pic.status = 'painting';
    pic.token = token;
    pic.tries += 1;
    this.inflight.add(token);
    if (useAi) this.ctx.checkpoint?.(); // count paid calls even if we restart mid-flight
    const job = useAi ? this.#paintAi(pic) : this.#paintSketch(pic);
    job.then(
      (key) => this.#painted(pic.id, token, key, useAi),
      (err) => this.#failed(pic.id, token, err),
    );
  }

  async #paintAi(pic) {
    const ctx = this.ctx;
    const stars = pic.stars.slice(0, MAX_REFS);
    const photos = await Promise.all(stars.map((id) => (ctx.photoOf ? ctx.photoOf(id) : null)));
    const names = stars.filter((id, i) => photos[i]).map((id) => plain(ctx.playerName(id)));
    const references = photos.filter(Boolean);
    const prompt = [
      `${pic.text.replace(/[.!?\s]+$/u, '')}.`,
      names.length ? `${names.map((n, i) => `${names.length > 1 ? `The person in reference photo ${i + 1}` : 'The person in the reference photo'} IS ${n}`).join('. ')}. Whenever the prompt mentions ${names.join(' or ')}, paint exactly that person, clearly recognisable; don't add anyone else for that name.` : '',
      'Bright, funny and vivid. No captions or lettering unless the prompt asks for words.',
    ].filter(Boolean).join(' ');
    const out = await ctx.images.generate({ prompt, references: references.length ? references : null });
    ctx.log(`double-take: ${pic.id} image in ${out.ms} ms (${out.bytes.length} bytes, ${references.length} refs)`);
    const ext = IMAGE_EXT[out.type] || 'jpg';
    return ctx.media.put(`gen/${ctx.roomCode || 'room'}-dt-${uid()}.${ext}`, out.bytes, out.type);
  }

  // The free fallback: a sketch card with the stars' names and most of the
  // prompt blanked out, so it's still a guessing game without an image model.
  async #paintSketch(pic) {
    const ctx = this.ctx;
    const bareWord = (w) => w.replace(/[^\p{L}\p{N}']/gu, '').replace(/'s$/i, '').toLowerCase();
    const names = new Set(pic.stars.flatMap((id) => plain(ctx.playerName(id)).split(/\s+/).map(bareWord)));
    const seed = [...`${pic.id}${pic.text}`].reduce((x, c) => x + c.charCodeAt(0), 0);
    let n = seed;
    const text = pic.text.split(/\s+/).map((w) => {
      const bare = bareWord(w);
      if (names.has(bare) || bare.length <= 3) return w;
      n = (n * 1103515245 + 12345) % 2147483648;
      return n % 100 < 70 ? '___' : w;
    }).join(' ');
    return ctx.media.put(`gen/${ctx.roomCode || 'room'}-dt-${uid()}.svg`, new TextEncoder().encode(placeholderSvg(text, seed)), 'image/svg+xml');
  }

  #pic(picId, token) {
    const pic = this.s.pics.find((x) => x.id === picId);
    return pic && pic.token === token ? pic : null;
  }

  #painted(picId, token, key, ai) {
    this.inflight.delete(token);
    if (this.dead) return;
    const pic = this.#pic(picId, token);
    if (pic) {
      Object.assign(pic, { status: 'done', key, token: null, ai });
      this.ctx.checkpoint?.(); // pictures cost money: never lose one to a restart
      this.#checkReady();
      this.ctx.update();
    }
    this.#pump();
  }

  #failed(picId, token, err) {
    this.inflight.delete(token);
    if (this.dead) return;
    const msg = String(err?.message || err || '');
    this.ctx.log(`double-take: picture ${picId} failed:`, msg);
    const pic = this.#pic(picId, token);
    if (pic) {
      pic.token = null;
      const refused = /safety|moderat|content polic|refus|blocked/i.test(msg);
      if (pic.sketch) pic.status = pic.tries >= 5 ? 'failed' : 'queued';
      else if (pic.tries < 2 && !refused) pic.status = 'queued'; // retry once
      else { pic.sketch = true; pic.status = 'queued'; } // then a sketch
      if (pic.status === 'failed') this.#checkReady();
      this.ctx.update();
    }
    this.#pump();
  }

  // -------------------------------------------------------------- pictures
  #syncRoster() {
    const s = this.s;
    const add = (this.ctx.newcomers?.(meta.maxPlayers) || []).filter((id) => !s.roster.includes(id));
    if (!add.length) return;
    for (const id of add) {
      s.roster.push(id);
      s.scores[id] = 0;
      s.roundStartScores[id] = 0;
      s.tallies[id] = zero();
    }
    this.ctx.addToRoster?.(add);
    this.ctx.sayLine('lateJoin', { name: joinNames(add.map((id) => this.ctx.playerName(id))) });
  }

  #half() { return Math.ceil(this.s.pics.length / 2); }

  #startPicture(idx) {
    const s = this.s;
    s.idx = idx;
    const pic = s.pics[idx];
    if (!pic) return this.#endOfPictures();
    if (idx > 0) this.#syncRoster();
    s.minUntil = Date.now() + PAINT_MIN_MS;
    this.ctx.setTimer('paintMin', PAINT_MIN_MS);
    this.#phase('painting', PAINT_WAIT_MS, 'paint');
    this.ctx.sfx('whoosh');
    if (pic.mult > 1 && s.pics[idx - 1]?.mult === 1) this.ctx.sayLine('dtSecondHalf', {});
    else if (idx > 0) this.ctx.sayLine('dtNextPicture', { n: pic.n, total: s.pics.length });
    this.#pump();
    return undefined;
  }

  #checkReady() {
    const s = this.s;
    if (s.phase !== 'painting') return;
    const pic = s.pics[s.idx];
    if (!pic) return;
    if (pic.status === 'failed') {
      // Even the sketch wouldn't draw: skip this one.
      pic.skipped = true;
      this.ctx.clearTimer('paint');
      this.ctx.clearTimer('paintMin');
      this.#nextAfter(s.idx);
      return;
    }
    if (pic.status !== 'done' || s.decoyState !== 'done' || Date.now() < s.minUntil - 50) return;
    this.#startGuess();
  }

  // Waited long enough: decoys from the bank if the model hasn't answered,
  // and a sketch if the picture still isn't there (a paid call that lands
  // later is ignored), so the game moves on.
  #paintTimeout() {
    const s = this.s;
    if (s.phase !== 'painting') return;
    const pic = s.pics[s.idx];
    if (s.decoyState === 'pending') {
      this.decoyToken ||= uid('d');
      this.#setDecoys(this.decoyToken, {});
    }
    if (pic.status !== 'done' && pic.status !== 'failed') {
      if (pic.token) this.inflight.delete(pic.token);
      Object.assign(pic, { status: 'queued', token: null, sketch: true });
      this.#paintPic(pic);
      this.ctx.sayLine('dtPaintingSlow', {});
    }
    this.#checkReady();
    this.ctx.update();
  }

  #guessers(pic) { return this.s.roster.filter((id) => id !== pic.author); }

  #startGuess() {
    const s = this.s;
    const pic = s.pics[s.idx];
    this.ctx.clearTimer('paint');
    this.ctx.clearTimer('paintMin');
    pic.startedAt = Date.now();
    // The author's tick shows up on the TV a few seconds in, like everyone
    // else's, so an un-ticked face doesn't give them away.
    pic.authorTickAt = pic.startedAt + 3000 + Math.floor(Math.random() * 6000);
    const first = !s.pics.some((p) => p.result);
    this.#phase('guess', GUESS_MS);
    this.ctx.music('voting');
    this.ctx.sfx('reveal');
    this.ctx.sayLine(first ? 'dtFirstPicture' : 'dtLookClose', {});
    this.ctx.buzz(s.roster, [40, 30, 40]);
    this.#botsGuess();
    this.#authorTick();
  }

  #authorTick() {
    const pic = this.s.pics[this.s.idx];
    if (!pic?.authorTickAt) return;
    this.ctx.later(Math.max(0, pic.authorTickAt - Date.now()) + 50, () => {
      if (this.s.phase === 'guess' && this.s.pics[this.s.idx]?.id === pic.id) this.ctx.update();
    });
  }

  #setPick(pid, picId, choice) {
    const s = this.s;
    const pic = s.pics[s.idx];
    if (!pic || pic.id !== picId || !s.roster.includes(pid) || pid === pic.author) return;
    if (!Number.isInteger(choice) || choice < 0 || choice >= (pic.options?.length || 0)) return;
    pic.picks[pid] = choice;
    if (pic.pickMs[pid] === undefined) pic.pickMs[pid] = Math.max(0, Date.now() - pic.startedAt);
    this.ctx.sfx('select');
    const everyone = this.#guessers(pic).filter((id) => this.ctx.isBot(id) || this.ctx.isConnected(id));
    if (everyone.length && everyone.every((id) => pic.picks[id] !== undefined)) {
      const left = (s.deadline || 0) - Date.now();
      if (left > GUESS_DONE_MS) s.deadline = this.ctx.setTimer('guess', GUESS_DONE_MS);
    }
    this.ctx.update();
  }

  #reveal() {
    const s = this.s;
    const pic = s.pics[s.idx];
    if (s.phase !== 'guess' || !pic || pic.result) return;
    this.ctx.clearTimer('guess');
    const right = {};
    const points = {};
    let spotted = 0;
    let fooled = 0;
    for (const id of this.#guessers(pic)) {
      const pick = pic.picks[id];
      const ok = pick === pic.real;
      right[id] = ok;
      points[id] = ok ? POINTS * pic.mult : 0;
      if (ok) spotted += 1;
      else if (pick !== undefined) fooled += 1;
      const t = s.tallies[id];
      if (!t) continue;
      t.picturesGuessed += 1;
      if (pick === undefined) t.blanks += 1;
      else {
        t.votesCast += 1;
        if (ok) t.correctPicks += 1; else t.fooledBy += 1;
      }
      if (pic.pickMs[id] !== undefined) { t.answerMs += pic.pickMs[id]; t.answerTimed += 1; }
    }
    points[pic.author] = spotted * AUTHOR_POINTS * pic.mult;
    for (const [id, pts] of Object.entries(points)) s.scores[id] = (s.scores[id] || 0) + pts;
    const ta = s.tallies[pic.author];
    if (ta) { ta.spottedBy += spotted; ta.peopleFooled += fooled; }
    pic.result = { right, points, spotted, fooled };
    this.#phase('reveal', REVEAL_MS);
    this.ctx.sfx('reveal');
    const name = this.ctx.playerName(pic.author);
    if (!spotted && !fooled) this.ctx.sayLine('dtRevealQuiet', { name });
    else if (!spotted) this.ctx.sayLine('dtRevealFooledAll', { name });
    else if (!fooled && spotted >= 2) this.ctx.sayLine('dtRevealEveryone', { name });
    else this.ctx.sayLine('dtRevealSpotted', { name, n: spotted });
  }

  #afterReveal() {
    if (this.s.phase !== 'reveal') return;
    this.#nextAfter(this.s.idx);
  }

  #nextAfter(idx) {
    const s = this.s;
    const next = idx + 1;
    if (next >= s.pics.length) return this.#endOfPictures();
    const played = s.pics.slice(0, next).some((p) => p.result);
    if (s.pics[idx].n === this.#half() && played) return this.#scores(next);
    return this.#startPicture(next);
  }

  #endOfPictures() {
    const s = this.s;
    s.idx = s.pics.length;
    if (s.pics.some((p) => p.result)) return this.#scores(s.pics.length);
    return this.#gameOver();
  }

  #scores(nextIdx) {
    const s = this.s;
    s.idx = nextIdx;
    this.#phase('scores', SCORES_MS);
    this.ctx.music('results');
    const ranking = this.#ranking();
    const leader = ranking[0];
    const close = ranking.length > 1 && leader.score - ranking[1].score < 500;
    this.ctx.sayLine(close ? 'scoresClose' : 'scores', { leader: this.ctx.playerName(leader.id), last: this.ctx.playerName(ranking.at(-1).id) });
    s.roundStartScores = { ...s.scores };
  }

  // ------------------------------------------------------------- game over
  #ranking() {
    const s = this.s;
    const sorted = [...s.roster].sort((x, y) => (s.scores[y] || 0) - (s.scores[x] || 0));
    let rank = 0;
    let prev = null;
    return sorted.map((id, i) => {
      if (s.scores[id] !== prev) { rank = i + 1; prev = s.scores[id]; }
      return { id, score: s.scores[id] || 0, rank, delta: (s.scores[id] || 0) - (s.roundStartScores[id] || 0) };
    });
  }

  #gameOver() {
    const s = this.s;
    if (s.phase === 'gameOver') return;
    const ranking = this.#ranking();
    s.awards = this.#awards(ranking);
    this.#phase('gameOver', GAME_OVER_MS);
    this.ctx.music('victory');
    this.ctx.sfx('fanfare');
    const winners = ranking.filter((r) => r.rank === 1).map((r) => this.ctx.playerName(r.id));
    this.ctx.sayLine(winners.length > 1 ? 'gameOverTie' : 'gameOver', { name: winners.join(' and ') });
    this.ctx.buzz(null, [100, 50, 100, 50, 200]);
  }

  #awards(ranking) {
    const s = this.s;
    const best = (field, min = 1) => {
      let top = null;
      for (const id of s.roster) {
        const v = s.tallies[id]?.[field] || 0;
        if (v >= min && (!top || v > top.v)) top = { id, v };
      }
      return top;
    };
    const out = [];
    const add = (key, line, hit) => {
      if (hit && !out.some((a) => a.playerId === hit.id && a.key === key)) {
        out.push({ key, title: this.ctx.line(line) || key, playerId: hit.id, name: this.ctx.playerName(hit.id), value: hit.v });
      }
    };
    add('dtEagle', 'dtAwardEagle', best('correctPicks', 2));
    add('dtArtist', 'dtAwardArtist', best('spottedBy', 2));
    add('dtStar', 'dtAwardStar', best('starredIn', 2));
    add('dtFooled', 'dtAwardFooled', best('fooledBy', 3));
    add('ghost', 'award_ghost', best('blanks', 2));
    const second = ranking.find((r) => r.rank === 2);
    if (second) add('bridesmaid', 'award_bridesmaid', { id: second.id, v: second.score });
    return out.slice(0, 4);
  }

  #finish() {
    const s = this.s;
    if (s.finished) return;
    s.finished = true;
    this.dead = true;
    const ranking = this.#ranking();
    // Each prompt a person actually wrote, with how many people spotted it.
    const answers = s.pics.filter((p) => p.result && !p.auto && !this.ctx.isBot(p.author)).map((p) => ({
      playerId: p.author, playerName: this.ctx.playerName(p.author), round: p.n,
      prompt: meta.name, answer: p.text, votes: p.result.spotted, totalVotes: Object.keys(p.result.right).length,
      won: p.result.spotted > 0, panic: false,
    }));
    const bestOf = (id) => {
      const a = answers.filter((x) => x.playerId === id && x.votes > 0).sort((x, y) => y.votes - x.votes)[0];
      return a ? { prompt: a.prompt, answer: a.answer, votes: a.votes, totalVotes: a.totalVotes } : null;
    };
    this.ctx.finish({
      gameType: meta.id,
      players: ranking.map((r) => ({ ...this.ctx.publicPlayer(r.id), score: r.score, rank: r.rank, counters: { ...s.tallies[r.id] }, best: bestOf(r.id) })),
      winnerIds: ranking.filter((r) => r.rank === 1 && r.score > 0).map((r) => r.id),
      answers,
      highlights: [...answers].sort((a, b) => (b.votes / Math.max(1, b.totalVotes)) - (a.votes / Math.max(1, a.totalVotes)))
        .slice(0, 5).map((a) => ({ name: a.playerName, prompt: a.prompt, answer: a.answer, votes: a.votes, totalVotes: a.totalVotes })),
      awards: s.awards,
    });
  }

  // ------------------------------------------------------------------ bots
  #botsWrite() {
    const s = this.s;
    for (const id of s.roster.filter((x) => this.ctx.isBot(x) && !s.prompts[x])) {
      this.ctx.later(1500 + Math.random() * 6000, () => {
        if (s.phase !== 'write' || s.prompts[id]) return;
        const text = s.suggest[id]?.[Math.floor(Math.random() * (s.suggest[id]?.length || 1))] || this.#bankBriefs(1)[0]?.text;
        if (text) this.#submit(id, text);
      });
    }
  }

  #botsGuess() {
    const s = this.s;
    const pic = s.pics[s.idx];
    if (!pic) return;
    for (const id of this.#guessers(pic).filter((x) => this.ctx.isBot(x) && pic.picks[x] === undefined)) {
      this.ctx.later(3000 + Math.random() * 10000, () => {
        if (s.phase !== 'guess' || s.pics[s.idx]?.id !== pic.id) return;
        // Decent but not psychic: right a bit under half the time.
        const fakes = pic.options.map((_, i) => i).filter((i) => i !== pic.real);
        this.#setPick(id, pic.id, Math.random() < 0.45 ? pic.real : fakes[Math.floor(Math.random() * fakes.length)]);
      });
    }
  }

  // ------------------------------------------------------------------ views
  #pub(id) { return this.ctx.publicPlayer(id); }
  #url(key) { return key ? this.ctx.media.url(key) : null; }

  #progress() {
    const pics = this.s.pics.filter((p) => !p.skipped);
    return { done: pics.filter((p) => p.status === 'done').length, total: pics.length };
  }

  #scoreboard() {
    return this.#ranking().map((r) => ({ ...this.#pub(r.id), score: r.score, rank: r.rank, delta: r.delta }));
  }

  hostView() {
    const s = this.s;
    const pic = s.pics[s.idx];
    const base = {
      phase: s.phase, deadline: s.deadline, timer: TIMED.includes(s.phase), timerTotal: s.timerMs,
      mode: meta.id, title: meta.name, picNo: pic?.n || 0, picTotal: s.pics.length, mult: pic?.mult || 1,
    };
    switch (s.phase) {
      case 'intro':
        return { ...base, tagline: meta.tagline, ai: !!this.ctx.images?.available() };
      case 'selfie':
        return { ...base, players: s.roster.map((id) => ({ ...this.#pub(id), done: !!s.selfies[id] })) };
      case 'write':
        return { ...base, players: s.roster.map((id) => ({ ...this.#pub(id), done: !!s.prompts[id] })) };
      case 'painting':
        return { ...base, ...this.#progress(), sketchOnly: s.sketchOnly };
      case 'guess': {
        // No secrets here: which caption is real (and whose it is) stays server-side.
        const authorDone = Date.now() >= (pic.authorTickAt || 0) || this.#guessers(pic).every((id) => pic.picks[id] !== undefined);
        return {
          ...base,
          image: this.#url(pic.key),
          captions: pic.options,
          guessers: s.roster.map((id) => ({ ...this.#pub(id), done: id === pic.author ? authorDone : pic.picks[id] !== undefined })),
        };
      }
      case 'reveal': {
        const r = pic.result;
        return {
          ...base,
          image: this.#url(pic.key),
          author: this.#pub(pic.author),
          spotted: r.spotted, guessed: Object.keys(r.right).length,
          captions: pic.options.map((text, i) => ({
            text, real: i === pic.real,
            pickers: this.#guessers(pic).filter((id) => pic.picks[id] === i).map((id) => this.#pub(id)),
          })),
          results: [...s.roster].filter((id) => r.points[id] !== undefined)
            .sort((a, b) => r.points[b] - r.points[a])
            .map((id) => ({ ...this.#pub(id), author: id === pic.author, right: !!r.right[id], picked: pic.picks[id] !== undefined, points: r.points[id] })),
        };
      }
      case 'scores':
        return { ...base, scoreboard: this.#scoreboard(), final: s.idx >= s.pics.length };
      case 'gameOver':
        return { ...base, scoreboard: this.#scoreboard(), awards: s.awards };
      default:
        return base;
    }
  }

  playerView(pid) {
    const s = this.s;
    const pic = s.pics[s.idx];
    const inGame = s.roster.includes(pid);
    const base = {
      phase: s.phase, deadline: s.deadline, timer: TIMED.includes(s.phase), timerTotal: s.timerMs,
      inGame, score: s.scores[pid] || 0, title: meta.name, picNo: pic?.n || 0, picTotal: s.pics.length, mult: pic?.mult || 1,
    };
    const watch = (key, extra = {}, vars = {}) => ({ ...base, screen: 'watch', text: this.#stableLine(key, vars), textKey: key, ...extra });
    switch (s.phase) {
      case 'intro':
        return watch('phoneIntro');
      case 'selfie':
        return inGame ? { ...base, screen: 'selfie', done: !!s.selfies[pid] } : watch('phoneDtAudience');
      case 'write':
        if (!inGame) return watch('phoneDtAudience');
        if (s.prompts[pid]) return watch('phoneDtSent', { mood: 'sent' });
        return {
          ...base, screen: 'write', maxChars: MAX_CHARS, suggestions: s.suggest[pid] || [],
          names: s.roster.map((id) => ({ ...this.#pub(id), name: firstName(this.ctx.playerName(id)), me: id === pid })),
        };
      case 'painting':
        return watch('phoneDtPainting');
      case 'guess':
        if (!inGame) return watch('phoneDtAudience');
        if (pid === pic.author) return watch('phoneDtYours', { mood: 'yours' });
        return { ...base, screen: 'guess', picId: pic.id, options: pic.options, picked: pic.picks[pid] ?? null };
      case 'reveal': {
        if (!inGame) return watch('phoneWatchReveal');
        const r = pic.result;
        const mine = pid === pic.author;
        const pick = pic.picks[pid];
        const key = mine ? (r.spotted ? 'phoneDtYoursSpotted' : 'phoneDtYoursFooled')
          : pick === undefined ? 'phoneDtNoPick' : r.right[pid] ? 'phoneDtRight' : 'phoneDtWrong';
        return {
          ...base, screen: 'result', mine, right: !!r.right[pid], picked: pick !== undefined, gained: r.points[pid] || 0,
          text: this.#stableLine(key, { n: r.spotted }), textKey: key,
          options: pic.options.map((text, i) => ({ text, real: i === pic.real, mine: pick === i, count: this.#guessers(pic).filter((id) => pic.picks[id] === i).length })),
        };
      }
      case 'gameOver': {
        const r = this.#ranking().find((x) => x.id === pid);
        return {
          ...base, screen: 'gameOver', rank: r?.rank || null, of: s.roster.length,
          awards: s.awards.filter((a) => a.playerId === pid).map((a) => a.title),
        };
      }
      default:
        return watch('phoneWatch');
    }
  }

  // The same line for a whole phase (views are rebuilt on every update).
  #stableLine(key, vars = {}) {
    const scene = this.sceneKey();
    if (this.lineCache?.scene !== scene) this.lineCache = { scene, lines: {} };
    const k = `${key}|${JSON.stringify(vars)}`;
    this.lineCache.lines[k] ??= this.ctx.line(key, vars) || '';
    return this.lineCache.lines[k];
  }
}
