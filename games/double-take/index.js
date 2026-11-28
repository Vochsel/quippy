// Double Take: two AI pictures of your mates, four captions, spot the real two.
//
//   1. Everyone takes (or keeps) a selfie: the robot paints people from it.
//   2. Five questions. The TV shows two pictures (A and B), each painted from a
//      secret brief starring players ("{player} as a Lego minifig…"). Phones
//      show four captions: the two real briefs plus two decoys starring the
//      same people. Tap the two you think made the pictures.
//   3. +500 per correct caption, +250 "Double Take!" bonus for both; questions
//      4 and 5 count double.
//
// Every picture is queued the moment the selfie step ends (a few at a time),
// so later questions are usually ready before anyone gets there. A picture
// that fails is retried once, then its brief is swapped for a decoy, then it
// falls back to a free "redacted sketch", so the game never stalls. Images are
// stored in the media store; state only keeps media keys. Rooms without an
// image model, and bot-only games, get sketches (no paid calls).
import { cleanText, fill, shuffle, uid } from '../../core/util.js';

// Names as they go into captions and image prompts (no bot emoji).
const plain = (name) => String(name || '').replace(/\s*🤖/gu, '').trim() || 'Someone';
import { placeholderSvg, IMAGE_EXT } from '../../core/images.js';

const QUESTIONS = 5;
const DOUBLE_FROM = 4; // questions 4-5 are worth x2
const SCORES_AFTER = 3; // a scoreboard after question 3 (and at the end)
const POINTS = 500;
const BONUS = 250;
const MAX_AI_IMAGES = 12; // cost guard: paid generations per game (incl. retries)
const CONCURRENCY = 4;
const INTRO_MS = 10000;
const SELFIE_MS = 45000;
const SELFIE_DONE_MS = 2500; // everyone's confirmed: a beat, then go
const PAINT_MIN_MS = 3500; // question title card, even when the pictures are ready
const PAINT_WAIT_MS = 60000; // then sketch whatever is still missing
const GUESS_MS = 25000;
const GUESS_DONE_MS = 2500; // everyone has two picks: a beat to change their minds
const REVEAL_MS = 12000;
const SCORES_MS = 9000;
const GAME_OVER_MS = 40000;
const TIMED = ['selfie', 'guess'];
const PHASE_TIMERS = ['intro', 'selfie', 'guess', 'reveal', 'scores', 'gameOver'];

const zero = () => ({
  questionsPlayed: 0, correctPicks: 0, doubleTakes: 0, fooledBy: 0, blanks: 0,
  votesCast: 0, answerMs: 0, answerTimed: 0,
});

const meta = {
  id: 'double-take',
  name: 'Double Take',
  tagline: 'Two AI pictures of your mates. Four captions. Spot the real two.',
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
      questions: [], qIdx: 0, aiSpent: 0, sketchOnly: false, minUntil: 0,
      awards: [], finished: false,
    };
  }

  serialize() { return this.s; }
  sceneKey() { return `${this.s.phase}|${this.s.qIdx}`; }

  // ------------------------------------------------------------- lifecycle
  start() {
    this.ctx.music('intro');
    this.#phase('intro', INTRO_MS);
    this.ctx.sayLine('dtIntro', { game: meta.name });
  }

  resume() {
    const s = this.s;
    const d = this.ctx.timerDeadline?.(s.phase);
    if (d) s.deadline = d;
    // Generations in flight died with the old process: queue them again.
    for (const q of s.questions) {
      for (const slot of q.slots) if (slot.status === 'painting') { slot.status = 'queued'; slot.token = null; }
    }
    this.inflight.clear();
    this.#pump();
    if (s.phase === 'painting') this.#checkReady();
    if (s.phase === 'guess') this.#botsGuess();
  }

  onTimer(name) {
    if (PHASE_TIMERS.includes(name) && this.s.phase !== name) return undefined; // stale
    switch (name) {
      case 'intro': return this.#startSelfies();
      case 'selfie': return this.#endSelfies();
      case 'paintMin': return this.#checkReady();
      case 'paint': return this.#paintTimeout();
      case 'guess': return this.#reveal();
      case 'reveal': return this.#afterReveal();
      case 'scores': return this.s.qIdx >= this.s.questions.length ? this.#gameOver() : this.#startQuestion(this.s.qIdx);
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
    } else if (p.type === 'picks' && s.phase === 'guess') {
      this.#setPicks(pid, p.qId, p.picks);
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
    this.#phase('selfie', SELFIE_MS);
    this.ctx.music('writing');
    if (needed.length) {
      this.ctx.sayLine('dtSelfie', {});
      this.ctx.buzz(needed, [80, 60, 80]);
    }
    if (this.#humans().every((id) => s.selfies[id])) this.#selfiesAllDone();
  }

  #selfiesAllDone() {
    const s = this.s;
    const left = (s.deadline || 0) - Date.now();
    if (left > SELFIE_DONE_MS) s.deadline = this.ctx.setTimer('selfie', SELFIE_DONE_MS);
  }

  #endSelfies() {
    const s = this.s;
    if (s.phase !== 'selfie') return;
    this.ctx.clearTimer('selfie');
    s.sketchOnly = !this.ctx.images?.available() || !this.#humans().length;
    s.questions = this.#buildQuestions();
    if (!s.questions.length) return this.#gameOver();
    this.ctx.sayLine(s.sketchOnly ? 'dtPaintingSketch' : 'dtPainting', {});
    this.#pump();
    return this.#startQuestion(0);
  }

  // ------------------------------------------------------- building briefs
  // Two kinds of brief: one star ({player}) or two ({player}, {player2}).
  #briefPools() {
    const c = this.ctx.content;
    const used = this.ctx.usedPrompts;
    const n = QUESTIONS * 2;
    let one = c.pickPeople?.(n, used, false) || [];
    let two = c.pickPeople?.(n, used, true) || [];
    if (one.length + two.length < QUESTIONS * 4) {
      // A pack without people briefs: borrow visual briefs and star someone in them.
      const extra = (c.pickPictures?.(QUESTIONS * 4, used) || c.pickPrompts(QUESTIONS * 4, used))
        .map((p) => ({ ...p, text: `{player} in: ${p.text}` }));
      one = [...one, ...extra];
    }
    return { one: shuffle(one), two: shuffle(two) };
  }

  #buildQuestions() {
    const s = this.s;
    const ctx = this.ctx;
    const pools = this.#briefPools();
    const stars = Object.fromEntries(s.roster.map((id) => [id, 0])); // pictures each player stars in
    const rank = (exclude) => shuffle(s.roster.filter((id) => !exclude.has(id)))
      .sort((a, b) => (stars[a] - stars[b]) || (ctx.hasPhoto?.(b) ? 1 : 0) - (ctx.hasPhoto?.(a) ? 1 : 0));
    // k distinct players, least-starred first, avoiding `avoid` where possible.
    const choose = (k, avoid) => {
      const out = rank(avoid).slice(0, k);
      if (out.length < k) out.push(...rank(new Set(out)).slice(0, k - out.length));
      return out;
    };
    const take = (k) => (k === 2 ? pools.two.shift() || pools.one.shift() : pools.one.shift() || pools.two.shift());
    const kindOf = (b) => (b.text.includes('{player2}') ? 2 : 1);
    const named = (b, ids) => ({
      text: cleanText(fill(b.text, { player: plain(ctx.playerName(ids[0])), player2: plain(ctx.playerName(ids[1] || ids[0])) }), 200),
      template: b.text, key: b.key || null, stars: ids,
    });
    const usedKeys = [];
    const out = [];
    for (let n = 0; n < QUESTIONS; n++) {
      const wantTwo = s.roster.length >= 3 && Math.random() < 0.6;
      const kinds = shuffle([1, wantTwo ? 2 : 1]);
      const real = kinds.map(take);
      const decoys = kinds.map(take);
      if ([...real, ...decoys].some((b) => !b)) break;
      // Real briefs: the least-starred players (photos first), spread out.
      const inQ = new Set();
      const realNamed = real.map((b) => {
        const ids = choose(kindOf(b), inQ);
        ids.forEach((id) => { inQ.add(id); stars[id] += 1; });
        return named(b, ids);
      });
      // Decoys star the same faces (so faces alone don't give it away), in a
      // different line-up from the real brief of the same kind.
      const faces = [...inQ];
      const decoyNamed = decoys.map((b, i) => {
        const k = kindOf(b);
        let ids = shuffle(faces).slice(0, k);
        const twin = realNamed[i].stars;
        for (let tries = 0; tries < 4 && faces.length > k && ids.join() === twin.join(); tries++) ids = shuffle(faces).slice(0, k);
        if (ids.length < k) ids.push(...choose(k - ids.length, new Set(ids)));
        return named(b, ids);
      });
      const options = shuffle([...realNamed.map((b, i) => ({ ...b, real: i })), ...decoyNamed.map((b) => ({ ...b, real: null }))]);
      const realIdx = [0, 1].map((i) => options.findIndex((o) => o.real === i));
      usedKeys.push(...options.map((o) => o.key).filter(Boolean));
      out.push({
        id: `q${n + 1}`, n: n + 1, mult: n + 1 >= DOUBLE_FROM ? 2 : 1,
        options: options.map(({ real: _r, ...o }) => o),
        real: realIdx, // SECRET until the reveal: options[real[0]] is picture A, options[real[1]] is B
        slots: realIdx.map(() => ({ status: 'queued', key: null, tries: 0, token: null, swapped: false, sketch: false, ai: false })),
        picks: {}, pickMs: {}, startedAt: null, result: null, skipped: false,
      });
    }
    ctx.markPromptsUsed(usedKeys);
    return out;
  }

  // -------------------------------------------------------------- painting
  // Start queued pictures (current question first), a few at a time.
  #pump() {
    const s = this.s;
    if (this.dead) return;
    for (const q of s.questions.slice(s.qIdx)) {
      if (q.skipped || q.result) continue;
      for (let i = 0; i < q.slots.length; i++) {
        if (this.inflight.size >= CONCURRENCY) return;
        if (q.slots[i].status === 'queued') this.#paintSlot(q, i);
      }
    }
  }

  #paintSlot(q, i) {
    const s = this.s;
    const slot = q.slots[i];
    const brief = q.options[q.real[i]];
    const token = uid('j');
    const useAi = !s.sketchOnly && !slot.sketch && s.aiSpent < MAX_AI_IMAGES;
    if (useAi) s.aiSpent += 1;
    slot.status = 'painting';
    slot.token = token;
    slot.tries += 1;
    this.inflight.add(token);
    if (useAi) this.ctx.checkpoint?.(); // count paid calls even if we restart mid-flight
    const job = useAi ? this.#paintAi(brief, q.id) : this.#paintSketch(brief, q.id);
    job.then(
      (key) => this.#painted(q.id, i, token, key, useAi),
      (err) => this.#failed(q.id, i, token, err),
    );
  }

  async #paintAi(brief, qid) {
    const ctx = this.ctx;
    const names = brief.stars.map((id) => plain(ctx.playerName(id)));
    const photos = await Promise.all(brief.stars.map((id) => (ctx.photoOf ? ctx.photoOf(id) : null)));
    const shown = brief.stars.map((id, i) => (photos[i] ? names[i] : null)).filter(Boolean);
    const refs = photos.filter(Boolean);
    const who = shown.length === 1
      ? ` The reference photo shows ${shown[0]}: keep their face recognisable.`
      : shown.length ? ` The reference photos show ${joinNames(shown)}, in that order: keep their faces recognisable.` : '';
    const prompt = `${brief.text}.${who} Bright, funny, vivid. No text, captions or lettering in the image.`;
    const out = await ctx.images.generate({ prompt, references: refs.length ? refs : null });
    ctx.log(`double-take: ${qid} image in ${out.ms} ms (${out.bytes.length} bytes, ${refs.length} refs)`);
    const ext = IMAGE_EXT[out.type] || 'jpg';
    return ctx.media.put(`gen/${ctx.roomCode || 'room'}-dt-${uid()}.${ext}`, out.bytes, out.type);
  }

  // The free fallback: a sketch card with the stars' names and half the brief
  // blanked out, so it's still a guessing game without an image model.
  async #paintSketch(brief, qid) {
    const ctx = this.ctx;
    const bareWord = (w) => w.replace(/[^\p{L}\p{N}']/gu, '').replace(/'s$/i, '').toLowerCase();
    const names = new Set(brief.stars.flatMap((id) => ctx.playerName(id).split(/\s+/).map(bareWord)));
    const seed = [...`${qid}${brief.text}`].reduce((x, c) => x + c.charCodeAt(0), 0);
    let n = seed;
    const text = brief.text.split(/\s+/).map((w) => {
      const bare = bareWord(w);
      if (names.has(bare) || bare.length <= 3) return w;
      n = (n * 1103515245 + 12345) % 2147483648;
      return n % 100 < 70 ? '___' : w;
    }).join(' ');
    return ctx.media.put(`gen/${ctx.roomCode || 'room'}-dt-${uid()}.svg`, new TextEncoder().encode(placeholderSvg(text, seed)), 'image/svg+xml');
  }

  #slot(qid, i, token) {
    const q = this.s.questions.find((x) => x.id === qid);
    const slot = q?.slots[i];
    return slot && slot.token === token ? { q, slot } : {};
  }

  #painted(qid, i, token, key, ai) {
    this.inflight.delete(token);
    if (this.dead) return;
    const { slot } = this.#slot(qid, i, token);
    if (slot) {
      Object.assign(slot, { status: 'done', key, token: null, ai });
      this.ctx.checkpoint?.(); // pictures cost money: never lose one to a restart
      this.#checkReady();
      this.ctx.update();
    }
    this.#pump();
  }

  #failed(qid, i, token, err) {
    this.inflight.delete(token);
    if (this.dead) return;
    const msg = String(err?.message || err || '');
    this.ctx.log(`double-take: picture ${qid}/${i} failed:`, msg);
    const { q, slot } = this.#slot(qid, i, token);
    if (slot) {
      slot.token = null;
      const refused = /safety|moderat|content polic|refus|blocked/i.test(msg);
      const decoy = q.options.findIndex((o, j) => !q.real.includes(j) && o.stars.length === q.options[q.real[i]].stars.length);
      if (slot.sketch) {
        slot.status = slot.tries >= 5 ? 'failed' : 'queued';
      } else if (slot.tries < 2 && !refused) {
        slot.status = 'queued'; // retry the same brief once
      } else if (!slot.swapped && decoy >= 0) {
        // Swap: that brief won't paint, so a decoy becomes the real one.
        slot.swapped = true;
        q.real[i] = decoy;
        slot.status = 'queued';
      } else {
        slot.sketch = true;
        slot.status = 'queued';
      }
      if (slot.status === 'failed') this.#checkReady();
      this.ctx.update();
    }
    this.#pump();
  }

  // ------------------------------------------------------------- questions
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

  #startQuestion(idx) {
    const s = this.s;
    s.qIdx = idx;
    const q = s.questions[idx];
    if (!q) return this.#endOfQuestions();
    if (idx > 0) this.#syncRoster();
    s.minUntil = Date.now() + PAINT_MIN_MS;
    this.ctx.setTimer('paintMin', PAINT_MIN_MS);
    this.#phase('painting', PAINT_WAIT_MS, 'paint');
    this.ctx.sfx('whoosh');
    if (q.n === DOUBLE_FROM) this.ctx.sayLine('dtDoublePoints', {});
    else if (idx > 0) this.ctx.sayLine('dtNextQuestion', { n: q.n, total: s.questions.length });
    this.#pump();
    return undefined;
  }

  #ready(q) { return q.slots.every((x) => x.status === 'done'); }

  #checkReady() {
    const s = this.s;
    if (s.phase !== 'painting') return;
    const q = s.questions[s.qIdx];
    if (!q) return;
    if (q.slots.some((x) => x.status === 'failed')) {
      // Even the sketch wouldn't draw: skip this one.
      q.skipped = true;
      this.ctx.clearTimer('paint');
      this.ctx.clearTimer('paintMin');
      this.#nextAfter(s.qIdx);
      return;
    }
    if (!this.#ready(q) || Date.now() < s.minUntil - 50) return;
    this.#startGuess();
  }

  // Waited long enough: sketch whatever is still missing (the paid call, if
  // it ever lands, is ignored) so the game moves on.
  #paintTimeout() {
    const s = this.s;
    if (s.phase !== 'painting') return;
    const q = s.questions[s.qIdx];
    for (let i = 0; i < q.slots.length; i++) {
      const slot = q.slots[i];
      if (slot.status === 'done') continue;
      if (slot.token) this.inflight.delete(slot.token);
      Object.assign(slot, { status: 'queued', token: null, sketch: true });
      this.#paintSlot(q, i);
    }
    this.ctx.sayLine('dtPaintingSlow', {});
    this.ctx.update();
  }

  #startGuess() {
    const s = this.s;
    const q = s.questions[s.qIdx];
    this.ctx.clearTimer('paint');
    this.ctx.clearTimer('paintMin');
    q.startedAt = Date.now();
    this.#phase('guess', GUESS_MS);
    this.ctx.music('voting');
    this.ctx.sfx('reveal');
    this.ctx.sayLine(s.qIdx === 0 ? 'dtFirstQuestion' : 'dtGuess', {});
    this.ctx.buzz(s.roster, [40, 30, 40]);
    this.#botsGuess();
  }

  #setPicks(pid, qId, picks) {
    const s = this.s;
    const q = s.questions[s.qIdx];
    if (!q || q.id !== qId || !s.roster.includes(pid) || !Array.isArray(picks)) return;
    const clean = [...new Set(picks.filter((x) => Number.isInteger(x) && x >= 0 && x < q.options.length))].slice(0, 2);
    q.picks[pid] = clean;
    if (clean.length === 2 && q.pickMs[pid] === undefined) q.pickMs[pid] = Math.max(0, Date.now() - q.startedAt);
    this.ctx.sfx('select');
    const everyone = s.roster.filter((id) => this.ctx.isBot(id) || this.ctx.isConnected(id));
    if (everyone.length && everyone.every((id) => q.picks[id]?.length === 2)) {
      const left = (s.deadline || 0) - Date.now();
      if (left > GUESS_DONE_MS) s.deadline = this.ctx.setTimer('guess', GUESS_DONE_MS);
    }
    this.ctx.update();
  }

  #reveal() {
    const s = this.s;
    const q = s.questions[s.qIdx];
    if (s.phase !== 'guess' || !q || q.result) return;
    this.ctx.clearTimer('guess');
    const right = {};
    const points = {};
    for (const id of s.roster) {
      const picks = q.picks[id] || [];
      const r = picks.filter((x) => q.real.includes(x)).length;
      const pts = (r * POINTS + (r === 2 ? BONUS : 0)) * q.mult;
      right[id] = r;
      points[id] = pts;
      s.scores[id] = (s.scores[id] || 0) + pts;
      const t = s.tallies[id];
      if (!t) continue;
      t.questionsPlayed += 1;
      t.correctPicks += r;
      t.fooledBy += picks.length - r;
      t.votesCast += picks.length;
      if (r === 2) t.doubleTakes += 1;
      if (!picks.length) t.blanks += 1;
      if (q.pickMs[id] !== undefined) { t.answerMs += q.pickMs[id]; t.answerTimed += 1; }
    }
    q.result = { right, points };
    this.#phase('reveal', REVEAL_MS);
    this.ctx.sfx('reveal');
    const guessed = s.roster.filter((id) => (q.picks[id] || []).length);
    const best = [...s.roster].sort((a, b) => points[b] - points[a])[0];
    if (guessed.length && guessed.every((id) => right[id] === 2)) this.ctx.sayLine('dtRevealAll', {});
    else if (s.roster.every((id) => !right[id])) this.ctx.sayLine('dtRevealNone', {});
    else if (right[best] === 2) this.ctx.sayLine('dtRevealDouble', { name: this.ctx.playerName(best) });
    else this.ctx.sayLine('dtReveal', {});
  }

  #afterReveal() {
    if (this.s.phase !== 'reveal') return;
    this.#nextAfter(this.s.qIdx);
  }

  #nextAfter(idx) {
    const s = this.s;
    const next = idx + 1;
    const played = s.questions.slice(0, next).filter((q) => q.result).length;
    if (next >= s.questions.length) return this.#endOfQuestions();
    if (s.questions[idx].n === SCORES_AFTER && played) return this.#scores(next);
    return this.#startQuestion(next);
  }

  #endOfQuestions() {
    const s = this.s;
    s.qIdx = s.questions.length;
    if (s.questions.some((q) => q.result)) return this.#scores(s.questions.length);
    return this.#gameOver();
  }

  #scores(nextIdx) {
    const s = this.s;
    s.qIdx = nextIdx;
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
    add('dtEagle', 'dtAwardEagle', best('doubleTakes', 2));
    add('dtFooled', 'dtAwardFooled', best('fooledBy', 3));
    // Photogenic: starred in the most real pictures.
    const starred = {};
    for (const q of s.questions) if (q.result) for (const i of q.real) for (const id of q.options[i].stars) starred[id] = (starred[id] || 0) + 1;
    const star = Object.entries(starred).sort((a, b) => b[1] - a[1])[0];
    if (star && s.roster.includes(star[0])) add('dtStar', 'dtAwardStar', { id: star[0], v: star[1] });
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
    // Highlights: the real captions, and how many people spotted each.
    const highlights = [];
    for (const q of s.questions) {
      if (!q.result) continue;
      q.real.forEach((i) => {
        const spotted = s.roster.filter((id) => (q.picks[id] || []).includes(i)).length;
        highlights.push({ name: joinNames(q.options[i].stars.map((id) => this.ctx.playerName(id))), prompt: meta.name, answer: q.options[i].text, votes: spotted, totalVotes: s.roster.length });
      });
    }
    this.ctx.finish({
      gameType: meta.id,
      players: ranking.map((r) => ({ ...this.ctx.publicPlayer(r.id), score: r.score, rank: r.rank, counters: { ...s.tallies[r.id] }, best: null })),
      winnerIds: ranking.filter((r) => r.rank === 1 && r.score > 0).map((r) => r.id),
      answers: [],
      highlights: highlights.sort((a, b) => a.votes - b.votes).slice(0, 5),
      awards: s.awards,
    });
  }

  // ------------------------------------------------------------------ bots
  #botsGuess() {
    const s = this.s;
    const q = s.questions[s.qIdx];
    if (!q) return;
    for (const id of s.roster.filter((x) => this.ctx.isBot(x) && !(q.picks[x]?.length === 2))) {
      this.ctx.later(3000 + Math.random() * 12000, () => {
        if (s.phase !== 'guess' || s.questions[s.qIdx]?.id !== q.id) return;
        // Bots are decent but not psychic: each pick is right a bit over half the time.
        const real = shuffle([...q.real]);
        const fake = shuffle(q.options.map((_, i) => i).filter((i) => !q.real.includes(i)));
        const picks = [];
        while (picks.length < 2) picks.push(Math.random() < 0.55 && real.length ? real.shift() : fake.shift() ?? real.shift());
        this.#setPicks(id, q.id, picks);
      });
    }
  }

  // ------------------------------------------------------------------ views
  #pub(id) { return this.ctx.publicPlayer(id); }
  #url(key) { return key ? this.ctx.media.url(key) : null; }

  #progress() {
    const slots = this.s.questions.filter((q) => !q.skipped).flatMap((q) => q.slots);
    return { done: slots.filter((x) => x.status === 'done').length, total: slots.length };
  }

  #scoreboard() {
    return this.#ranking().map((r) => ({ ...this.#pub(r.id), score: r.score, rank: r.rank, delta: r.delta }));
  }

  #letters(q) { return Object.fromEntries(q.real.map((opt, i) => [opt, i ? 'B' : 'A'])); }

  hostView() {
    const s = this.s;
    const q = s.questions[s.qIdx];
    const base = {
      phase: s.phase, deadline: s.deadline, timer: TIMED.includes(s.phase), timerTotal: s.timerMs,
      mode: meta.id, title: meta.name, qNo: q?.n || 0, qTotal: s.questions.length || QUESTIONS, mult: q?.mult || 1,
    };
    switch (s.phase) {
      case 'intro':
        return { ...base, tagline: meta.tagline, ai: !!this.ctx.images?.available() };
      case 'selfie':
        return { ...base, players: s.roster.map((id) => ({ ...this.#pub(id), done: !!s.selfies[id] })) };
      case 'painting':
        return { ...base, ...this.#progress(), ready: q.slots.filter((x) => x.status === 'done').length, sketchOnly: s.sketchOnly };
      case 'guess':
        // No secrets here: which captions are real stays server-side.
        return {
          ...base,
          images: q.slots.map((slot, i) => ({ letter: i ? 'B' : 'A', url: this.#url(slot.key) })),
          captions: q.options.map((o) => o.text),
          guessers: s.roster.map((id) => ({ ...this.#pub(id), done: (q.picks[id] || []).length === 2 })),
        };
      case 'reveal': {
        const letters = this.#letters(q);
        return {
          ...base,
          images: q.slots.map((slot, i) => ({ letter: i ? 'B' : 'A', url: this.#url(slot.key), caption: q.options[q.real[i]].text })),
          captions: q.options.map((o, i) => ({
            text: o.text, real: letters[i] || null,
            pickers: s.roster.filter((id) => (q.picks[id] || []).includes(i)).map((id) => this.#pub(id)),
          })),
          results: [...s.roster].sort((a, b) => q.result.points[b] - q.result.points[a])
            .map((id) => ({ ...this.#pub(id), right: q.result.right[id], points: q.result.points[id], guessed: (q.picks[id] || []).length > 0 })),
        };
      }
      case 'scores':
        return { ...base, scoreboard: this.#scoreboard(), final: s.qIdx >= s.questions.length };
      case 'gameOver':
        return { ...base, scoreboard: this.#scoreboard(), awards: s.awards };
      default:
        return base;
    }
  }

  playerView(pid) {
    const s = this.s;
    const q = s.questions[s.qIdx];
    const inGame = s.roster.includes(pid);
    const base = {
      phase: s.phase, deadline: s.deadline, timer: TIMED.includes(s.phase), timerTotal: s.timerMs,
      inGame, score: s.scores[pid] || 0, title: meta.name, qNo: q?.n || 0, qTotal: s.questions.length || QUESTIONS, mult: q?.mult || 1,
    };
    const watch = (key, extra = {}) => ({ ...base, screen: 'watch', text: this.#stableLine(key), textKey: key, ...extra });
    switch (s.phase) {
      case 'intro':
        return watch('phoneIntro');
      case 'selfie':
        return inGame ? { ...base, screen: 'selfie', done: !!s.selfies[pid] } : watch('phoneDtAudience');
      case 'painting':
        return watch('phoneDtPainting');
      case 'guess':
        if (!inGame) return watch('phoneDtAudience');
        return { ...base, screen: 'guess', qId: q.id, options: q.options.map((o) => o.text), picked: q.picks[pid] || [] };
      case 'reveal': {
        if (!inGame) return watch('phoneWatchReveal');
        const r = q.result.right[pid] || 0;
        const letters = this.#letters(q);
        const picks = q.picks[pid] || [];
        return {
          ...base, screen: 'result', right: r, gained: q.result.points[pid] || 0, guessed: picks.length > 0,
          text: this.#stableLine(!picks.length ? 'phoneDtNoPicks' : r === 2 ? 'phoneDtGotTwo' : r === 1 ? 'phoneDtGotOne' : 'phoneDtGotNone'),
          options: q.options.map((o, i) => ({ text: o.text, real: letters[i] || null, mine: picks.includes(i) })),
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
  #stableLine(key) {
    const scene = this.sceneKey();
    if (this.lineCache?.scene !== scene) this.lineCache = { scene, lines: {} };
    this.lineCache.lines[key] ??= this.ctx.line(key) || '';
    return this.lineCache.lines[key];
  }
}

