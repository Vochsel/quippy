// The "quip" engine: a head-to-head comedy writing game.
//
//   Round 1  every prompt goes to two players; everyone else votes (1000 pts pool)
//   Round 2  same again, double points (2000 pts pool)
//   Round 3  Final Showdown: everyone answers ONE prompt, everyone votes for
//            their favourites (no acronym/letters round)
//
// Where prompts come from (a prompt bank, a language model, callbacks to
// earlier answers...) is decided by a "provider", so Zinger Duel and Callback
// Club share this engine. All state lives in `this.s` (plain JSON) so the game
// can be snapshotted and resumed after a restart.
import { botAnswers, botJudge } from '../../core/botbrain.js';
import { aiMatchupQuips, aiScoresQuip } from './quips.js';
import { cleanText, fill, pick, shuffle, sleep, withTimeout } from '../../core/util.js';

// Every round is worth more: round 1 x1, round 2 x2, the final x3.
const FINAL_VOTE_POINTS = 200; // x3 in the final = 600 per vote
const WIN_BONUS = 100;
const SHUTOUT_BONUS = 250;
const REVEAL_MS = 9500;
const SCORES_MS = 9000;
const GAME_OVER_MS = 40000;
const TIMED = ['answer', 'vote', 'finalAnswer', 'finalVote'];
const READ_CAP_MS = 15000;
// The final read-out: the prompt, then every answer one by one.
const finalReadCapMs = (n) => Math.min(120000, 8000 + n * 10000);

export function defineQuipGame(meta, makeProvider) {
  return {
    ...meta,
    create: (ctx) => new QuipGame(ctx, null, makeProvider(ctx), meta),
    restore: (ctx, state) => new QuipGame(ctx, state, makeProvider(ctx), meta),
  };
}

export class QuipGame {
  constructor(ctx, state, provider, meta) {
    this.ctx = ctx;
    this.p = provider;
    this.meta = meta;
    this.epoch = 0; // bumps on every phase change so late async work can tell it's stale
    this.pending = {}; // round -> Promise<prompts> (in memory only)
    this.quips = {}; // matchup id -> Promise<string|null>
    this.s = state || this.#fresh();
  }

  #fresh() {
    const roster = this.ctx.roster();
    const zero = () => ({
      matchupsPlayed: 0, matchupsWon: 0, shutouts: 0, votesReceived: 0, votesCast: 0,
      panics: 0, noAnswers: 0, answersWritten: 0,
    });
    return {
      phase: 'intro', round: 0, roster, deadline: null,
      scores: Object.fromEntries(roster.map((id) => [id, 0])),
      roundStartScores: {},
      tallies: Object.fromEntries(roster.map((id) => [id, zero()])),
      matchups: [], matchIdx: 0, history: [], final: null, awards: [], loadingText: '',
    };
  }

  serialize() { return this.s; }

  // Identifies the current screen; voice lines from an older scene are dropped.
  sceneKey() { return `${this.s.phase}|${this.s.round}|${this.s.matchIdx}`; }

  // ------------------------------------------------------------- lifecycle
  async start() {
    this.ctx.music('intro');
    this.prefetch(1);
    const intro = this.p.introLine?.(this) || this.ctx.line('intro', { game: this.meta.name });
    const epoch = this.epoch;
    await this.ctx.voiceReady?.([intro], 5000);
    if (epoch !== this.epoch) return;
    this.#phase('intro', this.#fit(10000, intro), 'intro');
    this.ctx.say(intro);
  }

  resume() {
    const s = this.s;
    this.countdown = [];
    // Timers get a grace period on restore; show the real (new) deadline.
    const d = this.ctx.timerDeadline?.(s.phase);
    if (d) s.deadline = d;
    if (TIMED.includes(s.phase)) this.#scheduleCountdown();
    if (s.phase === 'intro') this.prefetch(1);
    if (s.phase === 'loading') this.beginRound(s.round);
    if (s.phase === 'answer' && s.answersClosed) this.#startVote();
    else if (s.phase === 'answer') this.#botsAnswer();
    if (s.phase === 'vote' && s.reading) { s.reading = true; this.#openVoting(); } else if (s.phase === 'vote') this.#botsVote();
    if (s.phase === 'finalAnswer' && s.final?.closed) this.#startFinalRead();
    else if (s.phase === 'finalAnswer') this.#botsFinalAnswer();
    // Restarted mid read-out: the TV's voice queue is gone, so just open voting.
    if (s.phase === 'finalVote' && s.final?.reading) this.#openFinalVoting();
    else if (s.phase === 'finalVote') this.#botsFinalVote();
  }

  // After a pause: show the real (shifted) deadline and restart the cosmetic
  // timers (countdown calls, bot moves) that the pause cancelled.
  onUnpause() {
    const s = this.s;
    const d = this.ctx.timerDeadline?.(s.phase);
    if (d) s.deadline = d;
    this.countdown = [];
    if (TIMED.includes(s.phase) && s.deadline && !s.reading && !s.final?.reading) this.#scheduleCountdown();
    if (s.phase === 'answer' && !s.answersClosed) this.#botsAnswer();
    if (s.phase === 'vote' && !s.reading) this.#botsVote();
    if (s.phase === 'finalAnswer') this.#botsFinalAnswer();
    if (s.phase === 'finalVote' && !s.final?.reading) this.#botsFinalVote();
  }

  onTimer(name) {
    switch (name) {
      case 'intro': return this.beginRound(1);
      case 'answer': return this.endAnswering();
      case 'vote': return this.reveal();
      case 'readCap': return this.#openVoting();
      case 'finalReadCap': return this.#openFinalVoting();
      case 'reveal': return this.#afterReveal();
      case 'scores': return this.beginRound(this.s.round + 1);
      case 'finalAnswer': return this.endFinalAnswering();
      case 'finalVote': return this.finalReveal();
      case 'finalReveal': return this.gameOver();
      case 'gameOver': return this.finish();
      default: return undefined;
    }
  }

  onContinue() {
    if (this.s.phase === 'gameOver') this.finish();
    else if (['reveal', 'scores', 'intro'].includes(this.s.phase)) this.onTimer(this.s.phase);
  }

  onHostAction(p) {
    if (p.type === 'skip') this.onContinue();
    if (p.type === 'readDone' && p.matchupId === 'final') this.#openFinalVoting();
    else if (p.type === 'readDone') this.#openVoting(p.matchupId);
  }

  onAction(pid, p) {
    const s = this.s;
    switch (p.type) {
      case 'answer':
      case 'panic': {
        // 'panic' (older phones) submits a canned answer directly; newer phones
        // show the suggestion first and send it back with panic: true.
        const panic = p.type === 'panic' || (p.panic === true && p.text === this.#panicFor(pid, p.matchupId));
        const text = p.type === 'panic' ? this.#panicFor(pid, p.matchupId) : p.text;
        if (s.phase === 'answer') this.#submitAnswer(pid, p.matchupId, text, panic);
        else if (s.phase === 'finalAnswer') this.#submitFinal(pid, text, panic);
        break;
      }
      case 'vote':
        if (s.phase === 'vote') this.#vote(pid, p.matchupId, p.choice);
        break;
      case 'finalVote':
        if (s.phase === 'finalVote') this.#finalVote(pid, p.picks);
        break;
      default:
        break;
    }
  }

  // Long enough to show the screen for `min` ms and say `text` in full (tones
  // with slower, wordier lines get more time) plus a beat for the animation.
  #fit(min, text, lead = 0) {
    const talk = this.ctx.speechMs?.(text) || 0;
    return Math.max(min, lead + talk + 1200);
  }

  // Reply-time stats (for the crew stats page): how long into the current
  // timed phase this is, and whether it's a last-gasp (final 5 seconds).
  #timing(tally, kind) {
    const s = this.s;
    if (!tally || !s.deadline || !s.timerMs) return;
    const left = s.deadline - Date.now();
    const took = Math.max(0, s.timerMs - left);
    tally[`${kind}Ms`] = (tally[`${kind}Ms`] || 0) + took;
    tally[`${kind}Timed`] = (tally[`${kind}Timed`] || 0) + 1;
    if (kind === 'answer' && left < 5000) tally.lastGasps = (tally.lastGasps || 0) + 1;
    if (kind === 'answer') tally.chars = (tally.chars || 0) + (tally.lastLen || 0);
  }

  #phase(name, ms = 0, timerName = name) {
    this.epoch += 1;
    for (const cancel of this.countdown || []) cancel();
    this.countdown = [];
    this.s.phase = name;
    this.s.deadline = ms ? this.ctx.setTimer(timerName, ms) : null;
    this.s.timerMs = ms || null;
    this.ctx.update();
    this.ctx.checkpoint?.();
    if (TIMED.includes(name) && ms) this.#scheduleCountdown();
    return this.epoch;
  }

  // Who's holding everyone up in the current timed phase.
  #pending() {
    const s = this.s;
    if (s.phase === 'answer') return s.roster.filter((id) => !this.#answeredAll(id));
    if (s.phase === 'finalAnswer') return s.roster.filter((id) => !s.final?.answers[id]);
    if (s.phase === 'vote') {
      const m = s.matchups[s.matchIdx];
      return m ? this.#eligibleVoters(m).filter((id) => !m.votes[id]) : [];
    }
    if (s.phase === 'finalVote') return this.#finalVoters().filter((id) => !s.final?.done?.[id] && this.#canFinalVote(id));
    return [];
  }

  // "Thirty seconds", "ten seconds" (with a roast for whoever's slow), then
  // "5, 4, 3, 2, 1". Per-player roasts are voiced ahead so they land on time.
  #scheduleCountdown() {
    const s = this.s;
    if (!s.deadline) return;
    const voting = s.phase === 'vote' || s.phase === 'finalVote';
    const humans = this.#pending().filter((id) => !this.ctx.isBot(id));
    const roasts = {};
    for (const id of humans) roasts[id] = this.ctx.line(voting ? 'slowRoastVote' : 'slowRoast', { name: this.ctx.playerName(id) });
    this.ctx.prewarm?.(Object.values(roasts));
    const epoch = this.epoch;
    const at = (secsLeft, fn) => {
      const ms = s.deadline - secsLeft * 1000 - Date.now();
      if (ms > 0) this.countdown.push(this.ctx.later(ms, () => { if (epoch === this.epoch) fn(); }));
    };
    const slow = (n) => this.#pending().filter((id) => roasts[id]).sort(() => Math.random() - 0.5).slice(0, n);
    // Kept brief: a time call at 30s, then one roast of a straggler at 10s.
    at(30, () => {
      if (!this.#pending().length) return;
      this.ctx.sayLine('thirtySeconds', {});
    });
    at(10, () => {
      const late = slow(1);
      if (late.length) this.ctx.say(roasts[late[0]]);
      else if (this.#pending().length) this.ctx.sayLine('tenSeconds', {});
    });
    // "5, 4, 3, 2, 1" is played by the TV itself, locked to its timer ring.
  }

  // ---------------------------------------------------------------- prompts
  prefetch(round) {
    if (this.pending[round] || round > 3) return;
    const gen = round === 3 ? this.p.finalPrompt(this) : this.p.roundPrompts(this, round, this.s.roster.length);
    this.pending[round] = Promise.resolve(gen).catch((e) => {
      this.ctx.log(`${this.meta.id}: prompt generation failed for round ${round}:`, e?.message || e);
      return null;
    });
  }

  // Anyone who missed the deal (phone was asleep, joined late) gets added at
  // the start of the next round, with a fresh score.
  #syncRoster() {
    const s = this.s;
    const add = this.ctx.newcomers?.(this.meta.maxPlayers || 16) || [];
    for (const id of add) {
      if (s.roster.includes(id)) continue;
      s.roster.push(id);
      s.scores[id] = 0;
      s.tallies[id] = { matchupsPlayed: 0, matchupsWon: 0, shutouts: 0, votesReceived: 0, votesCast: 0, panics: 0, noAnswers: 0, answersWritten: 0 };
    }
    if (add.length) {
      this.ctx.addToRoster?.(add);
      this.ctx.sayLine('lateJoin', { name: add.map((id) => this.ctx.playerName(id)).join(' and ') });
    }
  }

  async beginRound(r) {
    const s = this.s;
    if (r > 3) return this.gameOver();
    if (r > 1) this.#syncRoster();
    s.round = r;
    s.roundStartScores = { ...s.scores };
    s.loadingText = this.p.loadingText?.(r) || '';
    const epoch = this.#phase('loading');
    this.ctx.music(r === 3 ? 'final' : 'writing');
    const introLine = this.ctx.line(r === 3 ? 'finalRoundIntro' : r === 2 ? 'round2Intro' : 'round1Intro', {});
    this.ctx.say(introLine);
    this.prefetch(r);
    const [prompts] = await Promise.all([
      withTimeout(this.pending[r], this.ctx.llm?.available() ? 28000 : 8000).catch(() => null),
      // Let the round card breathe, and let Monty finish the intro.
      sleep(Math.max(r === 1 ? 1500 : 4000, (this.ctx.speechMs?.(introLine) || 0) + 300)),
    ]);
    if (epoch !== this.epoch) return undefined;
    delete this.pending[r];
    if (r === 3) return this.#startFinal(prompts);
    return this.#startAnswering(prompts);
  }

  #normalise(p) {
    if (!p) return null;
    if (typeof p === 'string') return { text: cleanText(p, 160), key: null };
    if (!p.text) return null;
    return { text: cleanText(p.text, 160), key: p.key || null, about: p.about || null, callback: p.callback || null };
  }

  // Replace {player} with someone who is NOT answering the prompt, so the
  // subject gets to judge what was written about them.
  #personalise(prompt, authors) {
    if (!prompt.text.includes('{player}')) return prompt;
    const others = this.s.roster.filter((id) => !authors.includes(id));
    const about = pick(others.length ? others : this.s.roster);
    return { ...prompt, text: fill(prompt.text, { player: this.ctx.playerName(about) }), aboutId: about };
  }

  #startAnswering(generated) {
    const s = this.s;
    const roster = shuffle(s.roster);
    const n = roster.length;
    // Everyone answers two prompts, whatever the crowd size: a ring of n
    // matchups where each player faces a different rival on each.
    const count = n;
    const authorsOf = (i) => [roster[i], roster[(i + 1) % n]];
    let list = (Array.isArray(generated) ? generated : []).map((p) => this.#normalise(p)).filter(Boolean);
    if (list.length < count) list = [...list, ...this.ctx.content.pickPrompts(count - list.length, this.ctx.usedPrompts)];
    list = list.slice(0, count);
    s.matchups = list.map((prompt, i) => {
      const authors = authorsOf(i);
      return { id: `r${s.round}m${i}`, round: s.round, prompt: this.#personalise(prompt, authors), authors, answers: {}, votes: {}, order: [], result: null };
    });
    this.ctx.markPromptsUsed(list.map((p) => p.key).filter(Boolean));
    this.ctx.prewarm?.(s.matchups.map((m) => m.prompt.text));
    s.matchIdx = 0;
    s.answersClosed = false;
    this.#phase('answer', this.ctx.timing.answer * 1000);
    this.ctx.sayLine('answerStart', {});
    this.ctx.buzz(s.roster, [80, 60, 80]);
    this.#botsAnswer();
  }

  // One stable "safety" answer per player per prompt, shown on their phone.
  #panicFor(pid, matchupId) {
    this.s.panicPicks ||= {};
    const k = `${pid}|${matchupId}`;
    this.s.panicPicks[k] ||= this.ctx.content.panic();
    return this.s.panicPicks[k];
  }

  #maxChars() {
    return this.ctx.settings.answerChars || 200;
  }

  #myMatchups(pid) {
    return this.s.matchups.filter((m) => m.authors.includes(pid));
  }

  #submitAnswer(pid, matchupId, text, panic) {
    if (this.s.answersClosed) return;
    const m = this.s.matchups.find((x) => x.id === matchupId);
    if (!m || !m.authors.includes(pid) || m.answers[pid]) return;
    const t = cleanText(text, this.#maxChars());
    if (!t) return;
    m.answers[pid] = { text: t, panic: !!panic };
    const tally = this.s.tallies[pid];
    if (tally) { tally.answersWritten += 1; if (panic) tally.panics += 1; tally.lastLen = t.length; }
    if (!this.ctx.isBot(pid)) this.#timing(tally, 'answer');
    this.ctx.sfx('submit');
    const done = this.s.matchups.every((x) => x.authors.every((a) => x.answers[a]));
    if (done) this.endAnswering();
    else this.ctx.update();
  }

  endAnswering() {
    const s = this.s;
    if (s.phase !== 'answer' || s.answersClosed) return;
    s.answersClosed = true;
    this.ctx.clearTimer('answer');
    for (const m of s.matchups) {
      for (const a of m.authors) if (!m.answers[a] && s.tallies[a]) s.tallies[a].noAnswers += 1;
    }
    this.ctx.sfx('buzzer');
    // Decide each matchup's A/B order and read-out now, so the voice for every
    // vote can be generated while the first ones are playing.
    const warm = [];
    for (const m of s.matchups) {
      if (m.authors.filter((a) => m.answers[a]).length < 2) continue;
      m.order = shuffle([...m.authors]);
      const [a, b] = m.order.map((id) => m.answers[id].text);
      m.readA = this.ctx.line('readAnswerA', { a }) || `"${a}".`;
      m.readB = this.ctx.line('readAnswerB', { b }) || `Or. "${b}".`;
      warm.push(m.prompt.text, m.readA, m.readB);
    }
    this.ctx.prewarm?.(warm);
    this.#botsJudgeRound();
    s.matchIdx = 0;
    const first = s.matchups.find((m) => m.readA);
    const epoch = this.epoch;
    const go = () => { if (epoch === this.epoch && s.phase === 'answer') this.#startVote(); };
    if (first && this.ctx.voiceReady) this.ctx.voiceReady([first.prompt.text, first.readA, first.readB], 6000).then(go);
    else go();
  }

  // Pick the result lines for both possible winners ahead of the reveal, and
  // start generating their audio while people vote.
  #prepareResultLines(m) {
    const [a, b] = m.authors;
    const n = (id) => this.ctx.playerName(id);
    m.lines = {
      win: { [a]: this.ctx.line('win', { name: n(a), other: n(b) }), [b]: this.ctx.line('win', { name: n(b), other: n(a) }) },
      shutout: { [a]: this.ctx.line('shutout', { name: n(a), other: n(b) }), [b]: this.ctx.line('shutout', { name: n(b), other: n(a) }) },
      tie: this.ctx.line('tie', {}),
      noVotes: this.ctx.line('noVotes', {}),
    };
    this.ctx.prewarm?.([...Object.values(m.lines.win), ...Object.values(m.lines.shutout), m.lines.tie]);
  }

  // ----------------------------------------------------------------- voting
  #eligibleVoters(m) {
    const everyone = [...new Set([...this.s.roster, ...this.ctx.audienceIds()])];
    return everyone.filter((id) => !m.authors.includes(id) && this.ctx.isConnected(id));
  }

  #startVote() {
    const s = this.s;
    const m = s.matchups[s.matchIdx];
    if (!m) return this.#roundScores();
    if (m.authors.filter((a) => m.answers[a]).length < 2) return this.reveal();
    if (!m.order?.length) m.order = shuffle([...m.authors]);
    // Read-out first: answers appear on the TV as Monty reads them (cues), and
    // voting opens when he's done (the TV reports back) or after a cap.
    s.reading = true;
    this.#phase('vote');
    this.ctx.setTimer('readCap', READ_CAP_MS);
    this.ctx.music('voting');
    this.ctx.sfx('whoosh');
    // A little segue now and then, so it doesn't sound like a loop.
    if (s.matchIdx > 0 && Math.random() < 0.25) this.ctx.sayLine('votePreamble', {});
    const [a, b] = m.order.map((id) => m.answers[id].text);
    this.ctx.sayCue(m.prompt.text, 'prompt', m.id);
    this.ctx.sayCue(m.readA || `"${a}".`, 'A', m.id);
    this.ctx.sayCue(m.readB || `Or. "${b}".`, 'B', m.id);
    this.#prepareResultLines(m);
    // Monty's personal jab for this matchup, written while the room votes: one
    // version per possible result, so the reveal can aim it at the right person.
    if (this.ctx.llm?.available() || this.p.quip) {
      const job = this.ctx.llm?.available() ? aiMatchupQuips(this.ctx, this, m) : this.p.quip(this, m);
      this.quips[m.id] = withTimeout(Promise.resolve(job), 20000).catch(() => null)
        .then((line) => {
          const all = typeof line === 'string' ? [line] : Object.values(line || {});
          this.ctx.prewarm?.(all.filter((t) => typeof t === 'string' && t.trim()).map((t) => cleanText(t, 220)));
          return line;
        });
    }
    if (s.matchIdx === s.matchups.length - 1) this.prefetch(s.round + 1);
    // No TV to read it out: open voting straight away.
    if (this.ctx.hostCount && this.ctx.hostCount() === 0) this.#openVoting(m.id);
    return undefined;
  }

  #openVoting(matchupId) {
    const s = this.s;
    const m = s.matchups[s.matchIdx];
    if (s.phase !== 'vote' || !s.reading || !m || (matchupId && matchupId !== m.id)) return;
    s.reading = false;
    this.ctx.clearTimer('readCap');
    this.#phase('vote', this.ctx.timing.vote * 1000);
    this.ctx.buzz(this.#eligibleVoters(m), [40]);
    this.#botsVote();
  }

  #vote(pid, matchupId, choice) {
    if (this.s.reading) return;
    const m = this.s.matchups[this.s.matchIdx];
    if (!m || m.id !== matchupId || m.authors.includes(pid) || m.votes[pid]) return;
    const target = choice === 'A' ? m.order[0] : choice === 'B' ? m.order[1] : null;
    if (!target || !m.answers[target]) return;
    m.votes[pid] = target;
    if (this.s.tallies[pid]) this.s.tallies[pid].votesCast += 1;
    if (!this.ctx.isBot(pid)) this.#timing(this.s.tallies[pid], 'vote');
    this.ctx.sfx('vote');
    const voters = this.#eligibleVoters(m);
    if (voters.every((id) => m.votes[id])) this.reveal();
    else this.ctx.update();
  }

  reveal() {
    const s = this.s;
    const m = s.matchups[s.matchIdx];
    if (!m || m.result) return;
    this.ctx.clearTimer('vote');
    const mult = s.round;
    const pool = 1000 * mult;
    const [a, b] = m.authors;
    const answered = m.authors.filter((x) => m.answers[x]);
    const count = (id) => Object.values(m.votes).filter((v) => v === id).length;
    const votes = { [a]: count(a), [b]: count(b) };
    const total = votes[a] + votes[b];
    const points = { [a]: 0, [b]: 0 };
    let kind;
    let winner = null;

    if (answered.length === 0) {
      kind = 'noContest';
    } else if (answered.length === 1) {
      kind = 'forfeit';
      winner = answered[0];
      points[winner] = pool / 2;
    } else {
      if (total > 0) {
        points[a] = Math.round((pool * votes[a]) / total);
        points[b] = Math.round((pool * votes[b]) / total);
      }
      if (votes[a] !== votes[b]) winner = votes[a] > votes[b] ? a : b;
      kind = total === 0 ? 'noVotes' : winner ? 'win' : 'tie';
      if (winner) {
        points[winner] += WIN_BONUS * mult;
        if (total >= 2 && votes[winner] === total) {
          kind = 'shutout';
          points[winner] += SHUTOUT_BONUS * mult;
          if (s.tallies[winner]) s.tallies[winner].shutouts += 1;
        }
      }
    }
    for (const id of m.authors) {
      s.scores[id] = (s.scores[id] || 0) + points[id];
      const t = s.tallies[id];
      if (t) {
        t.matchupsPlayed += 1;
        t.votesReceived += votes[id];
        if (winner === id) t.matchupsWon += 1;
      }
    }
    if (!m.order.length) m.order = [...m.authors];
    m.result = { kind, winner, votes, points, total, quip: null };
    // Last matchup of the round: the scoreboard line is now known, so voice it during the reveal.
    if (s.matchIdx === s.matchups.length - 1) {
      s.scoresLine = this.#scoresLine();
      this.ctx.prewarm?.([s.scoresLine]);
      // A personal scoreboard jab, ready (and voiced) by the time the board shows.
      this.scoresAi = null;
      if (this.ctx.llm?.available()) {
        const round = s.round;
        withTimeout(aiScoresQuip(this.ctx, this), 9000).catch(() => null).then((line) => {
          if (!line || this.s.round !== round) return;
          this.ctx.prewarm?.([line]);
          this.scoresAi = { round, line: cleanText(line, 240) };
        });
      }
    }
    const loser = winner && m.authors.find((x) => x !== winner);
    const vars = { name: winner ? this.ctx.playerName(winner) : '', other: loser ? this.ctx.playerName(loser) : '' };
    const lineKey = { shutout: 'shutout', forfeit: 'forfeit', tie: 'tie', win: 'win', noVotes: 'noVotes', noContest: 'noContest' }[kind];
    const pre = m.lines && (kind === 'win' || kind === 'shutout' ? m.lines[kind]?.[winner] : m.lines[kind]);
    const fallback = pre || this.ctx.line(lineKey, vars);
    // The result line is spoken once the cards have flipped (~3.5s in); an AI
    // quip can run to ~22 words, so budget for whichever is longer.
    const longest = this.quips[m.id] && fallback.split(/\s+/).length < 22 ? `${fallback} ${'word '.repeat(22 - fallback.split(/\s+/).length)}` : fallback;
    const epoch = this.#phase('reveal', this.#fit(REVEAL_MS, longest, 3500));
    // The TV times the shutout fanfare to its own animation.
    this.ctx.sfx('reveal');

    const quip = this.quips[m.id];
    delete this.quips[m.id];
    // Speak as the TV reveals who wrote what (authors ~2.4s, winner ~3.1s), so
    // Monty never announces the winner before the card shows it.
    const REVEAL_SPEAK_MS = 2400;
    if (!quip) {
      this.ctx.later(REVEAL_SPEAK_MS, () => { if (epoch === this.epoch) this.ctx.say(fallback); });
      return;
    }
    // Give the model a moment; if its line isn't ready, use a stock one.
    Promise.all([withTimeout(quip, 2500).catch(() => null), sleep(REVEAL_SPEAK_MS)]).then(([line]) => {
      if (epoch !== this.epoch) return;
      // Per-result lines: the winner's version, or the tie one.
      const chosen = typeof line === 'string' ? line
        : line && (kind === 'win' || kind === 'shutout') ? line[winner]
          : line && (kind === 'tie' || kind === 'noVotes') ? line.tie : null;
      const text = typeof chosen === 'string' && chosen.trim() ? cleanText(chosen, 220) : null;
      if (text) {
        m.result.quip = text;
        this.ctx.say(text);
      } else {
        this.ctx.say(fallback);
      }
      this.ctx.update();
    });
  }

  #afterReveal() {
    const s = this.s;
    s.matchIdx += 1;
    if (s.matchIdx < s.matchups.length) this.#startVote();
    else this.#roundScores();
  }

  #roundScores() {
    const s = this.s;
    s.history.push(...s.matchups);
    s.matchups = [];
    const ai = this.scoresAi?.round === s.round ? this.scoresAi.line : null;
    this.scoresAi = null;
    const line = ai || s.scoresLine || this.#scoresLine();
    // The board animates for ~2.5s before settling; the line plays over it.
    this.#phase('scores', this.#fit(SCORES_MS, line, 1500));
    this.ctx.music('results');
    this.ctx.say(line);
    s.scoresLine = null;
  }

  #scoresLine() {
    const s = this.s;
    const ranking = this.ranking();
    const leader = ranking[0];
    const last = ranking[ranking.length - 1];
    const prevLeader = Object.entries(s.roundStartScores).sort((x, y) => y[1] - x[1])[0]?.[0];
    const close = ranking.length > 1 && leader.score - ranking[1].score < 300;
    const key = close ? 'scoresClose' : prevLeader && prevLeader !== leader.id && s.round > 1 ? 'scoresNewLeader' : 'scores';
    return this.ctx.line(key, { leader: this.ctx.playerName(leader.id), last: this.ctx.playerName(last.id) });
  }

  // ------------------------------------------------------------ final round
  #startFinal(generated) {
    const s = this.s;
    let prompt = this.#normalise(Array.isArray(generated) ? generated[0] : generated);
    prompt ||= this.ctx.content.pickFinal(this.ctx.usedPrompts) || this.ctx.content.pickPrompts(1, this.ctx.usedPrompts)[0];
    prompt = this.#personalise(prompt, []);
    if (prompt.key) this.ctx.markPromptsUsed([prompt.key]);
    s.final = { prompt, answers: {}, order: [], votes: {}, votesPer: 1, result: null };
    const epoch = this.epoch;
    const go = () => { if (epoch === this.epoch) this.#openFinal(prompt); };
    if (this.ctx.voiceReady) this.ctx.voiceReady([prompt.text], 6000).then(go);
    else go();
  }

  #openFinal(prompt) {
    const s = this.s;
    this.#phase('finalAnswer', this.ctx.timing.finalAnswer * 1000);
    this.ctx.sayLine('finalAnswerStart', {});
    this.ctx.say(prompt.text);
    this.ctx.buzz(s.roster, [80, 60, 80]);
    this.#botsFinalAnswer();
  }

  #submitFinal(pid, text, panic) {
    const f = this.s.final;
    if (!f || f.closed || !this.s.roster.includes(pid) || f.answers[pid]) return;
    const t = cleanText(text, this.#maxChars());
    if (!t) return;
    f.answers[pid] = { text: t, panic: !!panic };
    const tally = this.s.tallies[pid];
    if (tally) { tally.answersWritten += 1; if (panic) tally.panics += 1; tally.lastLen = t.length; }
    if (!this.ctx.isBot(pid)) this.#timing(tally, 'answer');
    this.ctx.sfx('submit');
    if (this.s.roster.every((id) => f.answers[id])) this.endFinalAnswering();
    else this.ctx.update();
  }

  endFinalAnswering() {
    const s = this.s;
    const f = s.final;
    if (s.phase !== 'finalAnswer' || f.closed) return;
    this.ctx.clearTimer('finalAnswer');
    f.closed = true;
    s.deadline = null;
    for (const id of s.roster) if (!f.answers[id] && s.tallies[id]) s.tallies[id].noAnswers += 1;
    f.order = shuffle(Object.keys(f.answers));
    this.ctx.sfx('buzzer');
    if (f.order.length < 2) return this.finalReveal();
    f.votesPer = Math.max(1, Math.min(3, f.order.length - 2));
    // Pick every read-out line now so their audio is generated ahead.
    f.reads = f.order.map((id) => {
      const a = f.answers[id].text;
      return this.ctx.line('readFinalAnswer', { a }) || `"${a}".`;
    });
    f.voteLine = this.ctx.line('finalVoteStart', { n: f.votesPer });
    this.#botsJudgeFinal();
    this.ctx.prewarm?.([f.prompt.text, ...f.reads, f.voteLine]);
    this.ctx.update();
    this.ctx.checkpoint?.();
    const epoch = this.epoch;
    const go = () => { if (epoch === this.epoch && s.phase === 'finalAnswer') this.#startFinalRead(); };
    if (this.ctx.voiceReady) this.ctx.voiceReady([f.prompt.text, ...f.reads.slice(0, 2)], 6000).then(go);
    else go();
    return undefined;
  }

  // Monty reads the prompt, then each answer: the TV shows them one at a
  // time (cues F0, F1, ...; the last one is tagged ':last' so the TV reports
  // 'readDone' when it finishes). Voting opens then, or after a cap.
  #startFinalRead() {
    const s = this.s;
    const f = s.final;
    if (!f.reads?.length) f.reads = f.order.map((id) => `"${f.answers[id].text}".`);
    f.reading = true;
    this.#phase('finalVote');
    this.ctx.setTimer('finalReadCap', finalReadCapMs(f.order.length));
    this.ctx.music('voting');
    this.ctx.sfx('whoosh');
    this.ctx.sayCue(f.prompt.text, 'prompt', 'final');
    f.reads.forEach((line, i) => this.ctx.sayCue(line, `F${i}${i === f.reads.length - 1 ? ':last' : ''}`, 'final'));
    // No TV to read it out: open voting straight away.
    if (this.ctx.hostCount && this.ctx.hostCount() === 0) this.#openFinalVoting();
  }

  #openFinalVoting() {
    const s = this.s;
    const f = s.final;
    if (s.phase !== 'finalVote' || !f?.reading) return;
    f.reading = false;
    this.ctx.clearTimer('finalReadCap');
    this.#phase('finalVote', this.ctx.timing.finalVote * 1000);
    this.ctx.say(f.voteLine || this.ctx.line('finalVoteStart', { n: f.votesPer }));
    this.ctx.buzz(null, [40]);
    this.#botsFinalVote();
  }

  #finalVoters() {
    return [...new Set([...this.s.roster, ...this.ctx.audienceIds()])].filter((id) => this.ctx.isConnected(id));
  }

  // Each tap on a phone sends that player's current picks; they count
  // straight away (no "lock in"). Once someone has used all their picks
  // they're done, and when everyone is done the reveal starts.
  #picksNeeded(pid) {
    const f = this.s.final;
    return Math.min(f.votesPer, f.order.filter((a) => a !== pid).length);
  }

  #finalVote(pid, picks) {
    const f = this.s.final;
    if (!f || f.reading || !Array.isArray(picks)) return;
    f.done ||= {};
    if (f.done[pid]) return;
    const ids = [...new Set(picks)]
      .map((k) => f.order[Number(String(k).replace('f', ''))])
      .filter((author) => author && author !== pid)
      .slice(0, f.votesPer);
    if (!ids.length) { delete f.votes[pid]; this.ctx.update(); return; }
    const before = f.votes[pid]?.length || 0;
    f.votes[pid] = ids;
    if (this.s.tallies[pid]) this.s.tallies[pid].votesCast += ids.length - before;
    this.ctx.sfx('vote');
    if (ids.length >= this.#picksNeeded(pid)) f.done[pid] = true;
    if (this.#finalVoters().every((id) => f.done[id] || !this.#canFinalVote(id))) this.finalReveal();
    else this.ctx.update();
  }

  // Someone whose only option is their own answer can't vote.
  #canFinalVote(id) {
    return this.s.final.order.some((a) => a !== id);
  }

  finalReveal() {
    const s = this.s;
    const f = s.final;
    if (!f || f.result) return;
    this.ctx.clearTimer('finalVote');
    const votes = Object.fromEntries(f.order.map((id) => [id, 0]));
    for (const picks of Object.values(f.votes)) for (const id of picks) if (id in votes) votes[id] += 1;
    const totalVotes = Object.values(votes).reduce((x, y) => x + y, 0);
    const points = {};
    for (const id of f.order) {
      points[id] = votes[id] * FINAL_VOTE_POINTS * 3;
      s.scores[id] = (s.scores[id] || 0) + points[id];
      if (s.tallies[id]) s.tallies[id].votesReceived += votes[id];
    }
    const top = Math.max(0, ...Object.values(votes));
    const topVotes = Math.max(0, ...Object.values(votes));
    if (topVotes > 0) {
      for (const id of f.order) {
        if (votes[id] === topVotes) { points[id] += WIN_BONUS * 3; s.scores[id] += WIN_BONUS * 3; }
      }
    }
    f.result = {
      votes, points, totalVotes,
      ascending: [...f.order].sort((x, y) => votes[x] - votes[y]),
      winners: top > 0 ? f.order.filter((id) => votes[id] === top) : [],
    };
    // Reveal pace matches the TV: quicker per card when the grid is big.
    this.#phase('finalReveal', (f.order.length > 8 ? 1600 : 2600) * f.order.length + 6000);
    this.ctx.music('results');
    this.ctx.sfx('reveal');
    this.ctx.sayLine('finalReveal', {});
  }

  // ------------------------------------------------------------- game over
  ranking() {
    const s = this.s;
    const sorted = [...s.roster].sort((x, y) => (s.scores[y] || 0) - (s.scores[x] || 0));
    let rank = 0;
    let prev = null;
    return sorted.map((id, i) => {
      if (s.scores[id] !== prev) { rank = i + 1; prev = s.scores[id]; }
      return { id, score: s.scores[id] || 0, rank, delta: (s.scores[id] || 0) - (s.roundStartScores[id] || 0) };
    });
  }

  gameOver() {
    const s = this.s;
    if (s.phase === 'gameOver') return;
    const ranking = this.ranking();
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
    const add = (key, hit) => {
      if (!hit) return;
      out.push({ key, title: this.ctx.line(`award_${key}`) || key, playerId: hit.id, name: this.ctx.playerName(hit.id), value: hit.v });
    };
    add('crowd', best('votesReceived'));
    add('shutouts', best('shutouts'));
    add('panic', best('panics'));
    add('ghost', best('noAnswers'));
    const second = ranking.find((r) => r.rank === 2);
    if (second) add('bridesmaid', { id: second.id, v: second.score });
    return out.slice(0, 4);
  }

  allAnswers() {
    const s = this.s;
    const out = [];
    for (const m of [...s.history, ...s.matchups]) {
      const total = m.result?.total || 0;
      for (const id of m.authors) {
        if (!m.answers[id]) continue;
        out.push({
          playerId: id, playerName: this.ctx.playerName(id), round: m.round, prompt: m.prompt.text,
          answer: m.answers[id].text, votes: m.result?.votes?.[id] || 0, totalVotes: total,
          won: m.result?.winner === id, panic: m.answers[id].panic,
        });
      }
    }
    const f = s.final;
    if (f?.result) {
      for (const id of f.order) {
        out.push({
          playerId: id, playerName: this.ctx.playerName(id), round: 3, prompt: f.prompt.text,
          answer: f.answers[id].text, votes: f.result.votes[id] || 0, totalVotes: f.result.totalVotes,
          won: f.result.winners.includes(id), panic: f.answers[id].panic,
        });
      }
    }
    return out;
  }

  finish() {
    const s = this.s;
    if (s.finished) return;
    s.finished = true;
    const ranking = this.ranking();
    const answers = this.allAnswers();
    const bestOf = (id) => answers.filter((a) => a.playerId === id && a.votes > 0)
      .sort((x, y) => y.votes - x.votes || (y.votes / Math.max(1, y.totalVotes)) - (x.votes / Math.max(1, x.totalVotes)))[0] || null;
    const results = {
      gameType: this.meta.id,
      players: ranking.map((r) => ({
        ...this.ctx.publicPlayer(r.id), score: r.score, rank: r.rank, counters: { ...s.tallies[r.id] }, best: bestOf(r.id),
      })),
      winnerIds: ranking.filter((r) => r.rank === 1 && r.score > 0).map((r) => r.id),
      answers,
      highlights: [...answers].filter((a) => a.votes > 0).sort((x, y) => y.votes - x.votes).slice(0, 5)
        .map((a) => ({ name: a.playerName, prompt: a.prompt, answer: a.answer, votes: a.votes, totalVotes: a.totalVotes })),
      awards: s.awards,
    };
    this.ctx.finish(results);
  }

  // Signals the AI provider uses to adapt difficulty and style.
  signals() {
    const s = this.s;
    const t = Object.values(s.tallies);
    const written = t.reduce((x, y) => x + y.answersWritten, 0);
    const panics = t.reduce((x, y) => x + y.panics, 0);
    const missing = t.reduce((x, y) => x + y.noAnswers, 0);
    const done = s.history.filter((m) => m.result);
    const lengths = done.flatMap((m) => Object.values(m.answers).map((a) => a.text.length));
    return {
      panicRate: written ? panics / written : 0,
      noAnswerRate: written + missing ? missing / (written + missing) : 0,
      shutoutRate: done.length ? done.filter((m) => m.result.kind === 'shutout').length / done.length : 0,
      avgAnswerLength: lengths.length ? Math.round(lengths.reduce((x, y) => x + y, 0) / lengths.length) : 0,
    };
  }

  // --------------------------------------------------------------- bots
  #botLine() { return this.ctx.content.panic(); }
  #rand(min, max) { return min + Math.random() * (max - min); }

  // Bots with a language model write real answers (one call per batch) and
  // vote with a judge's taste; without one they panic and flip coins.
  #botIds() { return this.s.roster.filter((x) => this.ctx.isBot(x)); }
  #aiBots() { return this.ctx.llm?.available() && this.#botIds().length > 0; }

  // Run a bot model call once per key (resume() may ask again).
  #botJob(key, fn) {
    this.botJobs ||= {};
    if (this.botJobs[key]) return this.botJobs[key];
    // Callers re-check the phase before acting on the result.
    this.botJobs[key] = fn().catch((e) => { this.ctx.log?.('bot brain', String(e?.message || e)); return {}; });
    return this.botJobs[key];
  }

  #botsAnswer() {
    const jobs = [];
    for (const id of this.#botIds()) {
      for (const m of this.#myMatchups(id)) if (!m.answers[id]) jobs.push({ id, m, key: `${m.id}.${id}` });
    }
    if (!jobs.length) return;
    const submit = (job, text) => {
      if (this.s.phase === 'answer' && !this.s.answersClosed) this.#submitAnswer(job.id, job.m.id, text || this.#botLine(), false);
    };
    if (!this.#aiBots()) {
      for (const job of jobs) this.ctx.later(this.#rand(2500, 9000), () => submit(job));
      return;
    }
    const items = jobs.map((j) => ({ key: j.key, prompt: j.m.prompt.text, name: this.ctx.playerName(j.id) }));
    this.#botJob(`answer-${this.s.round}`, () => botAnswers(this.ctx, items, this.#maxChars())).then((written) => {
      if (!written) return;
      for (const job of jobs) this.ctx.later(this.#rand(300, 5000), () => submit(job, written[job.key]));
    });
  }

  // Once answers are in, a judge ranks each matchup; bots mostly follow it.
  #botsJudgeRound() {
    if (!this.#aiBots()) return;
    const s = this.s;
    const items = s.matchups.filter((m) => m.order?.length === 2)
      .map((m) => ({ key: m.id, prompt: m.prompt.text, options: m.order.map((id) => m.answers[id].text) }));
    this.#botJob(`judge-${s.round}`, () => botJudge(this.ctx, items)).then((ranked) => {
      if (!ranked) return;
      s.botPicks = Object.fromEntries(Object.entries(ranked).map(([k, r]) => [k, r[0] === 0 ? 'A' : 'B']));
    });
  }

  #botsJudgeFinal() {
    if (!this.#aiBots()) return;
    const f = this.s.final;
    const items = [{ key: 'final', prompt: f.prompt.text, options: f.order.map((id) => f.answers[id].text) }];
    this.#botJob('judge-final', () => botJudge(this.ctx, items)).then((ranked) => {
      if (ranked?.final) f.botRank = ranked.final;
    });
  }

  #botsVote() {
    const m = this.s.matchups[this.s.matchIdx];
    if (!m) return;
    for (const id of this.#eligibleVoters(m).filter((x) => this.ctx.isBot(x))) {
      this.ctx.later(this.#rand(2000, 6000), () => {
        if (this.s.phase !== 'vote' || this.s.matchups[this.s.matchIdx]?.id !== m.id) return;
        const judged = this.s.botPicks?.[m.id];
        // Mostly agree with the judge, with the odd contrarian.
        const choice = judged && Math.random() < 0.8 ? judged : pick(['A', 'B']);
        this.#vote(id, m.id, choice);
      });
    }
  }

  #botsFinalAnswer() {
    const bots = this.#botIds().filter((id) => !this.s.final?.answers[id]);
    if (!bots.length) return;
    const submit = (id, text) => { if (this.s.phase === 'finalAnswer') this.#submitFinal(id, text || this.#botLine(), false); };
    if (!this.#aiBots()) {
      for (const id of bots) this.ctx.later(this.#rand(3000, 10000), () => submit(id));
      return;
    }
    const prompt = this.s.final.prompt.text;
    const items = bots.map((id) => ({ key: id, prompt, name: this.ctx.playerName(id) }));
    this.#botJob('answer-final', () => botAnswers(this.ctx, items, this.#maxChars())).then((written) => {
      if (!written) return;
      for (const id of bots) this.ctx.later(this.#rand(300, 5000), () => submit(id, written[id]));
    });
  }

  #botsFinalVote() {
    const f = this.s.final;
    for (const id of this.#finalVoters().filter((x) => this.ctx.isBot(x))) {
      this.ctx.later(this.#rand(2500, 7000), () => {
        if (this.s.phase !== 'finalVote' || f.reading) return;
        const mine = f.order.indexOf(id);
        // Judge's ranking with a little shuffle so bots don't all vote the same.
        const ranked = (f.botRank || shuffle(f.order.map((_, i) => i))).filter((i) => i !== mine);
        const jiggled = ranked.map((i, n) => ({ i, k: n + Math.random() * 2.5 })).sort((a, b) => a.k - b.k).map((x) => x.i);
        this.#finalVote(id, jiggled.slice(0, f.votesPer).map((i) => `f${i}`));
      });
    }
  }

  // ------------------------------------------------------------------ views
  #pub(id) { return this.ctx.publicPlayer(id); }

  // Same random line for the whole phase, so phones don't flicker between variants.
  #stableLine(key) {
    if (this.lineCache?.epoch !== this.epoch) this.lineCache = { epoch: this.epoch, lines: {} };
    this.lineCache.lines[key] ??= this.ctx.line(key) || '';
    return this.lineCache.lines[key];
  }

  #answeredAll(id) {
    if (this.s.phase === 'finalAnswer') return !!this.s.final?.answers[id];
    return this.#myMatchups(id).every((m) => m.answers[id]);
  }

  #scoreboard() {
    return this.ranking().map((r) => ({ ...this.#pub(r.id), score: r.score, rank: r.rank, delta: r.delta }));
  }

  hostView() {
    const s = this.s;
    const base = {
      phase: s.phase, round: s.round, mult: Math.max(1, s.round), deadline: s.deadline, timer: TIMED.includes(s.phase), timerTotal: s.timerMs,
      mode: this.meta.id, title: this.meta.name, roundTitle: this.p.roundTitle?.(s.round) || null,
    };
    switch (s.phase) {
      case 'intro':
        return { ...base, tagline: this.meta.tagline, extra: this.p.introCard?.(this) || null };
      case 'loading':
        return { ...base, text: s.loadingText };
      case 'answer':
      case 'finalAnswer':
        return {
          ...base,
          prompt: s.phase === 'finalAnswer' ? s.final.prompt.text : null,
          closed: s.phase === 'answer' ? !!s.answersClosed : !!s.final?.closed,
          players: s.roster.map((id) => ({ ...this.#pub(id), done: this.#answeredAll(id) })),
        };
      case 'vote': {
        const m = s.matchups[s.matchIdx];
        const voters = this.#eligibleVoters(m);
        return {
          ...base, prompt: m.prompt.text, callback: m.prompt.callback || null,
          answers: m.order.map((id, i) => ({ key: i ? 'B' : 'A', text: m.answers[id].text })),
          reading: !!s.reading,
          votersDone: voters.filter((v) => m.votes[v]).length, votersTotal: voters.length,
          voters: voters.map((v) => ({ ...this.#pub(v), done: !!m.votes[v] })),
          matchNo: s.matchIdx + 1, matchTotal: s.matchups.length,
        };
      }
      case 'reveal': {
        const m = s.matchups[s.matchIdx];
        const r = m.result;
        return {
          ...base, prompt: m.prompt.text, kind: r.kind, quip: r.quip, total: r.total,
          matchNo: s.matchIdx + 1, matchTotal: s.matchups.length,
          answers: m.order.map((id) => ({
            text: m.answers[id]?.text || null, panic: !!m.answers[id]?.panic, author: this.#pub(id),
            votes: r.votes[id] || 0, points: r.points[id] || 0, winner: r.winner === id,
            pct: r.total ? Math.round(((r.votes[id] || 0) / r.total) * 100) : 0,
            voters: Object.entries(m.votes).filter(([, v]) => v === id).map(([voter]) => this.#pub(voter)),
          })),
        };
      }
      case 'scores':
        return { ...base, scoreboard: this.#scoreboard() };
      case 'finalVote': {
        const f = s.final;
        const voters = this.#finalVoters();
        return {
          ...base, prompt: f.prompt.text, votesPer: f.votesPer, reading: !!f.reading,
          answers: f.order.map((id, i) => ({ id: `f${i}`, text: f.answers[id].text })),
          votersDone: voters.filter((v) => f.done?.[v]).length, votersTotal: voters.length,
          voters: voters.map((v) => ({ ...this.#pub(v), done: !!f.done?.[v] })),
        };
      }
      case 'finalReveal': {
        const f = s.final;
        return {
          ...base, prompt: f.prompt.text,
          answers: (f.result?.ascending || []).map((id) => ({
            text: f.answers[id].text, panic: !!f.answers[id].panic, author: this.#pub(id),
            votes: f.result.votes[id], points: f.result.points[id], winner: f.result.winners.includes(id),
            voters: Object.entries(f.votes).filter(([, picks]) => picks.includes(id)).map(([voter]) => this.#pub(voter)),
          })),
        };
      }
      case 'gameOver':
        return { ...base, scoreboard: this.#scoreboard(), awards: s.awards };
      default:
        return base;
    }
  }

  playerView(pid) {
    const s = this.s;
    const inGame = s.roster.includes(pid);
    const base = {
      phase: s.phase, round: s.round, deadline: s.deadline, timer: TIMED.includes(s.phase), timerTotal: s.timerMs, inGame, score: s.scores[pid] || 0,
      title: this.meta.name, roundTitle: this.p.roundTitle?.(s.round) || null,
    };
    const watch = (key) => ({ ...base, screen: 'watch', text: this.#stableLine(key), textKey: key });

    switch (s.phase) {
      case 'intro':
        return watch('phoneIntro');
      case 'loading':
        return watch('phoneLoading');
      case 'answer': {
        if (!inGame) return watch('phoneAudienceWriting');
        if (s.answersClosed) return watch('phoneAnswered');
        const mine = this.#myMatchups(pid);
        const next = mine.find((m) => !m.answers[pid]);
        if (!next) return watch('phoneAnswered');
        return {
          ...base, screen: 'answer', matchupId: next.id, prompt: next.prompt.text, panicText: this.#panicFor(pid, next.id),
          index: mine.indexOf(next) + 1, total: mine.length, maxLength: this.#maxChars(),
        };
      }
      case 'finalAnswer': {
        if (!inGame) return watch('phoneAudienceWriting');
        if (s.final.answers[pid] || s.final.closed) return watch('phoneAnswered');
        return { ...base, screen: 'answer', matchupId: 'final', prompt: s.final.prompt.text, index: 1, total: 1, maxLength: this.#maxChars(), final: true, panicText: this.#panicFor(pid, 'final') };
      }
      case 'vote': {
        const m = s.matchups[s.matchIdx];
        if (m.authors.includes(pid)) return watch('phoneYourMatchup');
        if (s.reading) return watch('phoneListen');
        if (m.votes[pid]) return watch('phoneVoted');
        return {
          ...base, screen: 'vote', matchupId: m.id, prompt: m.prompt.text,
          options: m.order.map((id, i) => ({ id: i ? 'B' : 'A', text: m.answers[id].text })),
        };
      }
      case 'reveal': {
        const m = s.matchups[s.matchIdx];
        if (!m.authors.includes(pid)) return watch('phoneWatchReveal');
        const won = m.result.winner === pid;
        return { ...watch(won ? 'phoneWon' : m.result.winner ? 'phoneLost' : 'phoneDraw'), mood: won ? 'win' : 'lose', gained: m.result.points[pid] || 0 };
      }
      case 'finalVote': {
        const f = s.final;
        if (f.reading) return watch('phoneListen');
        if (f.done?.[pid]) return watch('phoneVoted');
        if (!this.#canFinalVote(pid)) return watch('phoneWatchReveal');
        return {
          ...base, screen: 'finalVote', prompt: f.prompt.text, votesPer: f.votesPer,
          options: f.order.map((id, i) => ({ id: `f${i}`, text: f.answers[id].text, mine: id === pid })),
        };
      }
      case 'gameOver': {
        const r = this.ranking().find((x) => x.id === pid);
        return {
          ...base, screen: 'gameOver', rank: r?.rank || null, of: s.roster.length,
          awards: s.awards.filter((a) => a.playerId === pid).map((a) => a.title),
        };
      }
      default:
        return watch('phoneWatch');
    }
  }
}
