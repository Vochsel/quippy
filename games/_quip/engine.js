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
import { cleanText, fill, pick, shuffle, sleep, withTimeout } from '../../core/util.js';

const FINAL_VOTE_POINTS = 400;
const WIN_BONUS = 100;
const SHUTOUT_BONUS = 250;
const REVEAL_MS = 9500;
const SCORES_MS = 9000;
const GAME_OVER_MS = 40000;
const TIMED = ['answer', 'vote', 'finalAnswer', 'finalVote'];

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

  // ------------------------------------------------------------- lifecycle
  start() {
    this.#phase('intro', 10000, 'intro');
    this.ctx.music('intro');
    const intro = this.p.introLine?.(this) || this.ctx.line('intro', { game: this.meta.name });
    this.ctx.say(intro);
    this.prefetch(1);
  }

  resume() {
    const s = this.s;
    if (s.phase === 'intro') this.prefetch(1);
    if (s.phase === 'loading') this.beginRound(s.round);
    if (s.phase === 'answer') this.#botsAnswer();
    if (s.phase === 'vote') this.#botsVote();
    if (s.phase === 'finalAnswer') this.#botsFinalAnswer();
    if (s.phase === 'finalVote') this.#botsFinalVote();
  }

  onTimer(name) {
    switch (name) {
      case 'intro': return this.beginRound(1);
      case 'answer': return this.endAnswering();
      case 'vote': return this.reveal();
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
  }

  onAction(pid, p) {
    const s = this.s;
    switch (p.type) {
      case 'answer':
      case 'panic': {
        const panic = p.type === 'panic';
        const text = panic ? this.ctx.content.panic() : p.text;
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

  #phase(name, ms = 0, timerName = name) {
    this.epoch += 1;
    this.s.phase = name;
    this.s.deadline = ms ? this.ctx.setTimer(timerName, ms) : null;
    this.s.timerMs = ms || null;
    this.ctx.update();
    return this.epoch;
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

  async beginRound(r) {
    const s = this.s;
    if (r > 3) return this.gameOver();
    s.round = r;
    s.roundStartScores = { ...s.scores };
    s.loadingText = this.p.loadingText?.(r) || '';
    const epoch = this.#phase('loading');
    this.ctx.music(r === 3 ? 'final' : 'writing');
    this.ctx.sayLine(r === 3 ? 'finalRoundIntro' : r === 2 ? 'round2Intro' : 'round1Intro', {});
    this.prefetch(r);
    const [prompts] = await Promise.all([
      withTimeout(this.pending[r], this.ctx.llm?.available() ? 28000 : 8000).catch(() => null),
      sleep(r === 1 ? 1500 : 4000), // let the round card breathe
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
    let list = (Array.isArray(generated) ? generated : []).map((p) => this.#normalise(p)).filter(Boolean);
    if (list.length < n) list = [...list, ...this.ctx.content.pickPrompts(n - list.length, this.ctx.usedPrompts)];
    list = list.slice(0, n);
    s.matchups = list.map((prompt, i) => {
      const authors = [roster[i], roster[(i + 1) % n]];
      return { id: `r${s.round}m${i}`, round: s.round, prompt: this.#personalise(prompt, authors), authors, answers: {}, votes: {}, order: [], result: null };
    });
    this.ctx.markPromptsUsed(list.map((p) => p.key).filter(Boolean));
    s.matchIdx = 0;
    this.#phase('answer', this.ctx.timing.answer * 1000);
    this.ctx.sayLine('answerStart', {});
    this.ctx.buzz(s.roster, [80, 60, 80]);
    this.#botsAnswer();
  }

  #myMatchups(pid) {
    return this.s.matchups.filter((m) => m.authors.includes(pid));
  }

  #submitAnswer(pid, matchupId, text, panic) {
    const m = this.s.matchups.find((x) => x.id === matchupId);
    if (!m || !m.authors.includes(pid) || m.answers[pid]) return;
    const t = cleanText(text, 80);
    if (!t) return;
    m.answers[pid] = { text: t, panic: !!panic };
    const tally = this.s.tallies[pid];
    if (tally) { tally.answersWritten += 1; if (panic) tally.panics += 1; }
    this.ctx.sfx('submit');
    const done = this.s.matchups.every((x) => x.authors.every((a) => x.answers[a]));
    if (done) this.endAnswering();
    else this.ctx.update();
  }

  endAnswering() {
    const s = this.s;
    if (s.phase !== 'answer') return;
    this.ctx.clearTimer('answer');
    for (const m of s.matchups) {
      for (const a of m.authors) if (!m.answers[a] && s.tallies[a]) s.tallies[a].noAnswers += 1;
    }
    this.ctx.sfx('buzzer');
    s.matchIdx = 0;
    this.#startVote();
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
    m.order = shuffle([...m.authors]);
    this.#phase('vote', this.ctx.timing.vote * 1000);
    this.ctx.music('voting');
    this.ctx.sfx('whoosh');
    this.ctx.say(m.prompt.text);
    const [a, b] = m.order.map((id) => m.answers[id].text);
    this.ctx.say(this.ctx.line('readAnswers', { a, b }) || `${a}. Or. ${b}.`);
    this.ctx.buzz(this.#eligibleVoters(m), [40]);
    if (this.p.quip) {
      this.quips[m.id] = withTimeout(Promise.resolve(this.p.quip(this, m)), 20000).catch(() => null);
    }
    if (s.matchIdx === s.matchups.length - 1) this.prefetch(s.round + 1);
    this.#botsVote();
    return undefined;
  }

  #vote(pid, matchupId, choice) {
    const m = this.s.matchups[this.s.matchIdx];
    if (!m || m.id !== matchupId || m.authors.includes(pid) || m.votes[pid]) return;
    const target = choice === 'A' ? m.order[0] : choice === 'B' ? m.order[1] : null;
    if (!target || !m.answers[target]) return;
    m.votes[pid] = target;
    if (this.s.tallies[pid]) this.s.tallies[pid].votesCast += 1;
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
    const epoch = this.#phase('reveal', REVEAL_MS);
    this.ctx.sfx(kind === 'shutout' ? 'shutout' : 'reveal');

    const loser = winner && m.authors.find((x) => x !== winner);
    const vars = { name: winner ? this.ctx.playerName(winner) : '', other: loser ? this.ctx.playerName(loser) : '' };
    const lineKey = { shutout: 'shutout', forfeit: 'forfeit', tie: 'tie', win: 'win', noVotes: 'noVotes', noContest: 'noContest' }[kind];
    const fallback = this.ctx.line(lineKey, vars);
    const quip = this.quips[m.id];
    delete this.quips[m.id];
    if (!quip) {
      this.ctx.say(fallback);
      return;
    }
    // Give the model a moment; if its line isn't ready, use a stock one.
    withTimeout(quip, 2500).catch(() => null).then((line) => {
      if (epoch !== this.epoch) return;
      const text = typeof line === 'string' && line.trim() ? cleanText(line, 200) : null;
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
    this.#phase('scores', SCORES_MS);
    this.ctx.music('results');
    const ranking = this.ranking();
    const leader = ranking[0];
    const last = ranking[ranking.length - 1];
    const prevLeader = Object.entries(s.roundStartScores).sort((x, y) => y[1] - x[1])[0]?.[0];
    const close = ranking.length > 1 && leader.score - ranking[1].score < 300;
    const key = close ? 'scoresClose' : prevLeader && prevLeader !== leader.id && s.round > 1 ? 'scoresNewLeader' : 'scores';
    this.ctx.sayLine(key, { leader: this.ctx.playerName(leader.id), last: this.ctx.playerName(last.id) });
  }

  // ------------------------------------------------------------ final round
  #startFinal(generated) {
    const s = this.s;
    let prompt = this.#normalise(Array.isArray(generated) ? generated[0] : generated);
    prompt ||= this.ctx.content.pickFinal(this.ctx.usedPrompts) || this.ctx.content.pickPrompts(1, this.ctx.usedPrompts)[0];
    prompt = this.#personalise(prompt, []);
    if (prompt.key) this.ctx.markPromptsUsed([prompt.key]);
    s.final = { prompt, answers: {}, order: [], votes: {}, votesPer: 1, result: null };
    this.#phase('finalAnswer', this.ctx.timing.finalAnswer * 1000);
    this.ctx.sayLine('finalAnswerStart', {});
    this.ctx.say(prompt.text);
    this.ctx.buzz(s.roster, [80, 60, 80]);
    this.#botsFinalAnswer();
  }

  #submitFinal(pid, text, panic) {
    const f = this.s.final;
    if (!f || !this.s.roster.includes(pid) || f.answers[pid]) return;
    const t = cleanText(text, 80);
    if (!t) return;
    f.answers[pid] = { text: t, panic: !!panic };
    const tally = this.s.tallies[pid];
    if (tally) { tally.answersWritten += 1; if (panic) tally.panics += 1; }
    this.ctx.sfx('submit');
    if (this.s.roster.every((id) => f.answers[id])) this.endFinalAnswering();
    else this.ctx.update();
  }

  endFinalAnswering() {
    const s = this.s;
    if (s.phase !== 'finalAnswer') return;
    this.ctx.clearTimer('finalAnswer');
    const f = s.final;
    for (const id of s.roster) if (!f.answers[id] && s.tallies[id]) s.tallies[id].noAnswers += 1;
    f.order = shuffle(Object.keys(f.answers));
    this.ctx.sfx('buzzer');
    if (f.order.length < 2) return this.finalReveal();
    f.votesPer = Math.max(1, Math.min(3, f.order.length - 2));
    this.#phase('finalVote', this.ctx.timing.finalVote * 1000);
    this.ctx.music('voting');
    this.ctx.sayLine('finalVoteStart', { n: f.votesPer });
    this.ctx.buzz(null, [40]);
    this.#botsFinalVote();
    return undefined;
  }

  #finalVoters() {
    return [...new Set([...this.s.roster, ...this.ctx.audienceIds()])].filter((id) => this.ctx.isConnected(id));
  }

  #finalVote(pid, picks) {
    const f = this.s.final;
    if (!f || f.votes[pid] || !Array.isArray(picks)) return;
    const ids = [...new Set(picks)]
      .map((k) => f.order[Number(String(k).replace('f', ''))])
      .filter((author) => author && author !== pid)
      .slice(0, f.votesPer);
    if (!ids.length) return;
    f.votes[pid] = ids;
    if (this.s.tallies[pid]) this.s.tallies[pid].votesCast += ids.length;
    this.ctx.sfx('vote');
    if (this.#finalVoters().every((id) => f.votes[id] || (!this.#canFinalVote(id)))) this.finalReveal();
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
      points[id] = votes[id] * FINAL_VOTE_POINTS;
      s.scores[id] = (s.scores[id] || 0) + points[id];
      if (s.tallies[id]) s.tallies[id].votesReceived += votes[id];
    }
    const top = Math.max(0, ...Object.values(votes));
    f.result = {
      votes, points, totalVotes,
      ascending: [...f.order].sort((x, y) => votes[x] - votes[y]),
      winners: top > 0 ? f.order.filter((id) => votes[id] === top) : [],
    };
    this.#phase('finalReveal', 2600 * f.order.length + 6000);
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

  #botsAnswer() {
    for (const id of this.s.roster.filter((x) => this.ctx.isBot(x))) {
      for (const m of this.#myMatchups(id)) {
        if (m.answers[id]) continue;
        this.ctx.later(this.#rand(2500, 9000), () => {
          if (this.s.phase === 'answer') this.#submitAnswer(id, m.id, this.#botLine(), false);
        });
      }
    }
  }

  #botsVote() {
    const m = this.s.matchups[this.s.matchIdx];
    if (!m) return;
    for (const id of this.#eligibleVoters(m).filter((x) => this.ctx.isBot(x))) {
      this.ctx.later(this.#rand(2000, 6000), () => {
        if (this.s.phase === 'vote' && this.s.matchups[this.s.matchIdx]?.id === m.id) this.#vote(id, m.id, pick(['A', 'B']));
      });
    }
  }

  #botsFinalAnswer() {
    for (const id of this.s.roster.filter((x) => this.ctx.isBot(x))) {
      this.ctx.later(this.#rand(3000, 10000), () => {
        if (this.s.phase === 'finalAnswer') this.#submitFinal(id, this.#botLine(), false);
      });
    }
  }

  #botsFinalVote() {
    const f = this.s.final;
    for (const id of this.#finalVoters().filter((x) => this.ctx.isBot(x))) {
      this.ctx.later(this.#rand(2500, 7000), () => {
        if (this.s.phase !== 'finalVote') return;
        const options = f.order.map((a, i) => (a === id ? null : `f${i}`)).filter(Boolean);
        this.#finalVote(id, shuffle(options).slice(0, f.votesPer));
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
      phase: s.phase, round: s.round, deadline: s.deadline, timer: TIMED.includes(s.phase), timerTotal: s.timerMs,
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
          players: s.roster.map((id) => ({ ...this.#pub(id), done: this.#answeredAll(id) })),
        };
      case 'vote': {
        const m = s.matchups[s.matchIdx];
        const voters = this.#eligibleVoters(m);
        return {
          ...base, prompt: m.prompt.text, callback: m.prompt.callback || null,
          answers: m.order.map((id, i) => ({ key: i ? 'B' : 'A', text: m.answers[id].text })),
          votersDone: voters.filter((v) => m.votes[v]).length, votersTotal: voters.length,
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
          ...base, prompt: f.prompt.text, votesPer: f.votesPer,
          answers: f.order.map((id, i) => ({ id: `f${i}`, text: f.answers[id].text })),
          votersDone: voters.filter((v) => f.votes[v]).length, votersTotal: voters.length,
        };
      }
      case 'finalReveal': {
        const f = s.final;
        return {
          ...base, prompt: f.prompt.text,
          answers: (f.result?.ascending || []).map((id) => ({
            text: f.answers[id].text, panic: !!f.answers[id].panic, author: this.#pub(id),
            votes: f.result.votes[id], points: f.result.points[id], winner: f.result.winners.includes(id),
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
        const mine = this.#myMatchups(pid);
        const next = mine.find((m) => !m.answers[pid]);
        if (!next) return watch('phoneAnswered');
        return {
          ...base, screen: 'answer', matchupId: next.id, prompt: next.prompt.text,
          index: mine.indexOf(next) + 1, total: mine.length, maxLength: 80,
        };
      }
      case 'finalAnswer': {
        if (!inGame) return watch('phoneAudienceWriting');
        if (s.final.answers[pid]) return watch('phoneAnswered');
        return { ...base, screen: 'answer', matchupId: 'final', prompt: s.final.prompt.text, index: 1, total: 1, maxLength: 80, final: true };
      }
      case 'vote': {
        const m = s.matchups[s.matchIdx];
        if (m.authors.includes(pid)) return watch('phoneYourMatchup');
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
        if (f.votes[pid]) return watch('phoneVoted');
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
