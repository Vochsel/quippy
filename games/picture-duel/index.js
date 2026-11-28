// Picture Duel: Zinger Duel with AI pictures.
//
//   It opens with a selfie step: every player takes (or keeps) a selfie, which
//   becomes their profile photo. Each round every player gets ONE brief that
//   stars a player ("Ben as a Bunnings action figure"), shared with exactly
//   one rival. On their phone they write an image prompt, generate up to 3
//   pictures (the starring players' selfies are used automatically, nobody
//   uploads anything), pick one and send it. Then each pair goes head to head:
//   everyone else votes for the better picture. Round 1 is worth x1, round 2 x2.
//
// Images are generated server-side (ctx.images) and stored in the media store
// (ctx.media); game state only keeps media keys. Bots, tests and rooms without
// a gateway key get a free SVG placeholder instead of a real image.
import { cleanText, pick, shuffle, uid } from '../../core/util.js';
import { placeholderSvg, IMAGE_EXT } from '../../core/images.js';

const ROUNDS = 2;
const MAX_TRIES = 3; // pictures per player per brief
const MAX_ATTEMPTS = 5; // tries + failed attempts (stops endless retries on errors)
const PROMPT_CHARS = 240;
const WIN_BONUS = 100;
const SHUTOUT_BONUS = 250;
const LOADING_MS = 3500;
const REVEAL_MS = 15500; // includes ~7s of the winning picture full-screen
const SCORES_MS = 9000;
const GAME_OVER_MS = 40000;
const GRACE_MS = 25000; // after the timer, wait this long for pictures still painting
const SELFIE_MS = 45000;
const TIMED = ['selfie', 'create', 'vote'];

const zero = () => ({
  matchupsPlayed: 0, matchupsWon: 0, shutouts: 0, votesReceived: 0, votesCast: 0,
  imagesGenerated: 0, picturesSubmitted: 0, refsUsed: 0, noAnswers: 0,
});

const meta = {
  id: 'picture-duel',
  name: 'Picture Duel',
  tagline: 'Describe a picture, the robot paints it, the room picks the winner.',
  minPlayers: 3,
  maxPlayers: 16,
  accent: '#3fd0c9',
  client: 'picture-duel',
  usesAi: true,
};

export default {
  ...meta,
  create: (ctx) => new PictureDuel(ctx, null),
  restore: (ctx, state) => new PictureDuel(ctx, state),
};

class PictureDuel {
  constructor(ctx, state) {
    this.ctx = ctx;
    this.epoch = 0;
    this.countdown = [];
    this.s = state || this.#fresh();
  }

  #fresh() {
    const roster = this.ctx.roster();
    return {
      phase: 'intro', round: 0, roster, deadline: null, timerMs: null,
      scores: Object.fromEntries(roster.map((id) => [id, 0])),
      roundStartScores: {},
      tallies: Object.fromEntries(roster.map((id) => [id, zero()])),
      extras: {}, // who has had to draw two briefs (odd player counts)
      starred: {}, // how often each player has starred in a brief
      selfies: {}, // who has confirmed their selfie this game
      matchups: [], matchIdx: 0, history: [], awards: [], closing: false,
    };
  }

  serialize() { return this.s; }
  sceneKey() { return `${this.s.phase}|${this.s.round}|${this.s.matchIdx}`; }

  // ------------------------------------------------------------- lifecycle
  start() {
    this.ctx.music('intro');
    this.#phase('intro', 10000);
    this.ctx.sayLine('pdIntro', { game: meta.name });
  }

  resume() {
    const s = this.s;
    const d = this.ctx.timerDeadline?.(s.phase);
    if (d) s.deadline = d;
    if (s.phase === 'create') {
      // In-flight generations died with the old process: let people try again.
      for (const m of s.matchups) {
        for (const e of Object.values(m.entries)) {
          if (e.busy) { e.busy = null; e.attempts = Math.max(0, e.attempts - 1); e.error = 'The painter got interrupted. Tap Generate again.'; }
        }
      }
      if (s.closing) this.#endCreate();
      else { this.#botsCreate(); this.#scheduleCountdown(); }
    }
    if (s.phase === 'vote') this.#botsVote();
    if (s.phase === 'selfie') this.#scheduleCountdown();
  }

  onTimer(name) {
    switch (name) {
      case 'intro': return this.#startSelfies();
      case 'selfie': return this.#beginRound(1);
      case 'loading': return this.#startCreate();
      case 'create': return this.#closeCreate();
      case 'createGrace': return this.#endCreate();
      case 'vote': return this.#reveal();
      case 'reveal': return this.#afterReveal();
      case 'scores': return this.#beginRound(this.s.round + 1);
      case 'gameOver': return this.#finish();
      default: return undefined;
    }
  }

  onContinue() {
    if (this.s.phase === 'gameOver') this.#finish();
    else if (['reveal', 'scores', 'intro', 'selfie'].includes(this.s.phase)) this.onTimer(this.s.phase);
  }

  onHostAction(p) {
    if (p?.type === 'skip') this.onContinue();
  }

  onAction(pid, p) {
    if (!p || typeof p !== 'object') return;
    const s = this.s;
    switch (p.type) {
      case 'selfieDone':
        if (s.phase === 'selfie' && s.roster.includes(pid)) {
          s.selfies[pid] = true;
          if (this.#humans().every((id) => s.selfies[id])) this.onTimer('selfie');
          else this.ctx.update();
        }
        break;
      case 'generate':
        if (s.phase === 'create') this.#generate(pid, p.matchupId, p.prompt, p.ref);
        break;
      case 'pick':
        if (s.phase === 'create') this.#pick(pid, p.matchupId, p.idx);
        break;
      case 'submit':
        if (s.phase === 'create') this.#submit(pid, p.matchupId, p.idx);
        break;
      case 'vote':
        if (s.phase === 'vote') this.#vote(pid, p.matchupId, p.choice);
        break;
      default:
        break;
    }
  }

  #phase(name, ms = 0, timerName = name) {
    this.epoch += 1;
    for (const cancel of this.countdown) cancel();
    this.countdown = [];
    this.s.phase = name;
    this.s.deadline = ms ? this.ctx.setTimer(timerName, ms) : null;
    this.s.timerMs = ms || null;
    this.ctx.update();
    this.ctx.checkpoint?.();
    return this.epoch;
  }

  #scheduleCountdown() {
    const s = this.s;
    if (!s.deadline) return;
    const epoch = this.epoch;
    const ms = s.deadline - 30000 - Date.now();
    if (ms > 0) {
      this.countdown.push(this.ctx.later(ms, () => {
        if (epoch === this.epoch && s.phase === 'create' && s.roster.some((id) => !this.#doneAll(id))) this.ctx.sayLine('thirtySeconds', {});
      }));
    }
  }

  // --------------------------------------------------------------- rounds
  #syncRoster() {
    const s = this.s;
    const add = this.ctx.newcomers?.(meta.maxPlayers) || [];
    for (const id of add) {
      if (s.roster.includes(id)) continue;
      s.roster.push(id);
      s.scores[id] = 0;
      s.tallies[id] = zero();
    }
    if (add.length) {
      this.ctx.addToRoster?.(add);
      this.ctx.sayLine('lateJoin', { name: add.map((id) => this.ctx.playerName(id)).join(' and ') });
    }
  }

  #humans() { return this.s.roster.filter((id) => !this.ctx.isBot(id) && this.ctx.isConnected(id)); }

  // Everyone takes (or keeps) a selfie: briefs star the players, painted from these.
  #startSelfies() {
    const s = this.s;
    // Faces are remembered: anyone with a saved selfie is already done (they
    // can retake from their phone), so only people without one are asked.
    for (const id of s.roster) if (this.ctx.isBot(id) || this.ctx.hasPhoto?.(id)) s.selfies[id] = true;
    const needed = this.#humans().filter((id) => !s.selfies[id]);
    if (!needed.length) return this.#beginRound(1);
    this.#phase('selfie', SELFIE_MS);
    this.#scheduleCountdown();
    this.ctx.sayLine('pdSelfie', {});
    this.ctx.buzz(needed, [80, 60, 80]);
    return undefined;
  }

  // Who stars in a brief: players with a photo first (they can be painted
  // properly), then whoever has starred least, ideally not the two authors.
  #cast(authors, n) {
    const s = this.s;
    const score = (id) => (this.ctx.hasPhoto?.(id) ? 0 : 10) + (s.starred[id] || 0) * 2 + (authors.includes(id) ? 3 : 0) + Math.random();
    const picked = [...s.roster].sort((a, b) => score(a) - score(b)).slice(0, n);
    for (const id of picked) s.starred[id] = (s.starred[id] || 0) + 1;
    return picked;
  }

  #beginRound(r) {
    const s = this.s;
    if (r > ROUNDS) return this.#gameOver();
    if (r > 1) this.#syncRoster();
    s.round = r;
    s.roundStartScores = { ...s.scores };
    s.loadingText = this.ctx.line('phonePdLoading') || '';
    this.#phase('loading', LOADING_MS);
    this.ctx.music('writing');
    this.ctx.sayLine(r === 2 ? 'pdRound2Intro' : 'pdRound1Intro', {});
    return undefined;
  }

  // Pair players up on a shared brief. With an odd count, one player (a
  // different one each round where possible) draws a second brief.
  #deal() {
    const s = this.s;
    const order = shuffle(s.roster);
    const pairs = [];
    for (let i = 0; i + 1 < order.length; i += 2) pairs.push([order[i], order[i + 1]]);
    if (order.length % 2) {
      const odd = order[order.length - 1];
      const others = order.slice(0, -1);
      const least = Math.min(...others.map((id) => s.extras[id] || 0));
      const partner = pick(others.filter((id) => (s.extras[id] || 0) === least));
      s.extras[partner] = (s.extras[partner] || 0) + 1;
      pairs.push(shuffle([odd, partner]));
    }
    return pairs;
  }

  #startCreate() {
    const s = this.s;
    const pairs = this.#deal();
    const used = this.ctx.usedPrompts;
    // Briefs star players ("{player} as a Bunnings action figure"); about a
    // third star two. Falls back to the plain visual briefs if a pack has none.
    const people = this.ctx.content.pickPeople?.(pairs.length * 2, used) || [];
    const ones = people.filter((p) => !p.text.includes('{player2}'));
    const twos = people.filter((p) => p.text.includes('{player2}'));
    let plain = null;
    const brief = (i, authors) => {
      const want2 = s.roster.length >= 4 && i % 3 === 2 && twos.length;
      const b = (want2 ? twos.shift() : ones.shift()) || twos.shift() || ones.shift();
      if (!b) {
        plain ||= this.ctx.content.pickPictures?.(pairs.length, used) || this.ctx.content.pickPrompts(pairs.length, used);
        const p = plain[i] || plain[0];
        return { text: cleanText(p?.text || 'Something wonderful', 160), key: p?.key || null, stars: [] };
      }
      const stars = this.#cast(authors, b.text.includes('{player2}') ? 2 : 1);
      const bare = (id) => this.ctx.playerName(id).replace(/\s*🤖/gu, '').trim();
      const text = b.text.replaceAll('{player}', bare(stars[0])).replaceAll('{player2}', bare(stars[1] || stars[0]));
      return { text: cleanText(text, 160), key: b.key || null, stars };
    };
    s.matchups = pairs.map((authors, i) => ({
      id: `r${s.round}m${i}`, round: s.round,
      prompt: brief(i, authors),
      authors,
      entries: Object.fromEntries(authors.map((a) => [a, { tries: [], picked: null, submitted: false, final: null, busy: null, error: null, attempts: 0 }])),
      votes: {}, order: [], result: null,
    }));
    this.ctx.markPromptsUsed(s.matchups.map((m) => m.prompt.key).filter(Boolean));
    s.matchIdx = 0;
    s.closing = false;
    const secs = Math.max(120, (this.ctx.timing.answer || 90) + 60);
    this.#phase('create', secs * 1000);
    this.#scheduleCountdown();
    this.ctx.sayLine('pdCreateStart', {});
    this.ctx.buzz(s.roster, [80, 60, 80]);
    this.#botsCreate();
  }

  #entry(pid, matchupId) {
    const m = this.s.matchups.find((x) => x.id === matchupId);
    return m && m.authors.includes(pid) ? { m, e: m.entries[pid] } : {};
  }

  #busy(pid) {
    return this.s.matchups.some((m) => m.entries[pid]?.busy);
  }

  #generate(pid, matchupId, text, ref) {
    const s = this.s;
    const { m, e } = this.#entry(pid, matchupId);
    if (!e || e.submitted) return;
    const prompt = cleanText(text, PROMPT_CHARS);
    if (!prompt) return;
    // Cost guards: one picture at a time per player, MAX_TRIES per brief.
    if (this.#busy(pid) || e.tries.length >= MAX_TRIES || e.attempts >= MAX_ATTEMPTS) return;
    const refKey = typeof ref === 'string' && ref.startsWith(`ref/${pid}-`) && /^ref\/[\w-]{6,100}\.jpg$/.test(ref) ? ref : null;
    const token = uid('j');
    e.busy = { token, prompt, ref: refKey, at: Date.now() };
    e.error = null;
    e.attempts += 1;
    this.ctx.update();
    this.#paint(pid, prompt, refKey, m.id).then(
      (key) => this.#painted(pid, m.id, token, key),
      (err) => this.#failed(pid, m.id, token, err),
    );
  }

  // -> media key of the finished picture.
  async #paint(pid, prompt, refKey, matchupId) {
    const ctx = this.ctx;
    const name = `${ctx.roomCode || 'room'}-${uid()}`;
    if (ctx.isBot(pid) || !ctx.images?.available()) {
      const seed = [...`${pid}${prompt}`].reduce((x, c) => x + c.charCodeAt(0), 0);
      return ctx.media.put(`gen/${name}.svg`, new TextEncoder().encode(placeholderSvg(prompt, seed)), 'image/svg+xml');
    }
    // The brief's stars are painted from their selfies (taken at the start).
    const m = this.s.matchups.find((x) => x.id === matchupId);
    const stars = (m?.prompt.stars || []);
    const photos = await Promise.all(stars.map((id) => ctx.photoOf?.(id)));
    const withPhoto = stars.filter((id, i) => photos[i]);
    const references = photos.filter(Boolean);
    const extra = refKey ? await ctx.media.get(refKey) : null;
    if (extra) references.push(extra);
    const names = withPhoto.map((id) => ctx.playerName(id).replace(/\s*🤖/gu, '').trim());
    const text = [
      prompt,
      names.length ? `${names.map((n, i) => `${names.length > 1 ? `The person in reference photo ${i + 1}` : 'The person in the reference photo'} IS ${n}`).join('. ')}. Whenever the prompt mentions ${names.join(' or ')}, paint exactly that person, clearly recognisable; don't add anyone else for that name.` : '',
      extra ? 'Also feature the person or thing in the last reference photo.' : '',
      'Bright, funny and vivid. No captions or lettering unless the prompt asks for words.',
    ].filter(Boolean).join(' ');
    const out = await ctx.images.generate({ prompt: text, references });
    ctx.log(`picture-duel: ${matchupId} image in ${out.ms} ms (${out.bytes.length} bytes)`);
    const ext = IMAGE_EXT[out.type] || 'jpg';
    return ctx.media.put(`gen/${name}.${ext}`, out.bytes, out.type);
  }

  #painted(pid, matchupId, token, key) {
    const { e } = this.#entry(pid, matchupId);
    if (!e || e.busy?.token !== token) return; // stale (game moved on / restarted)
    e.tries.push({ key, prompt: e.busy.prompt, ref: e.busy.ref });
    e.picked = e.tries.length - 1;
    e.busy = null;
    const t = this.s.tallies[pid];
    if (t) { t.imagesGenerated += 1; if (e.tries.at(-1).ref) t.refsUsed += 1; }
    this.ctx.update();
    this.ctx.checkpoint?.(); // pictures cost money: never lose one to a restart
    if (this.s.closing && !this.#anyBusy()) this.#endCreate();
    else if (this.ctx.isBot(pid)) this.#botNext(pid, matchupId);
  }

  #failed(pid, matchupId, token, err) {
    const { e } = this.#entry(pid, matchupId);
    this.ctx.log(`picture-duel: generation failed for ${pid}:`, err?.message || err);
    if (!e || e.busy?.token !== token) return;
    e.busy = null;
    const msg = String(err?.message || '');
    e.error = /safety|moderat|content polic|refus|blocked/i.test(msg)
      ? 'The robot refused to paint that one. Try a different prompt.'
      : /timeout|abort/i.test(msg) ? 'The robot took too long. Try again?' : 'The robot spilled its paint. Try again?';
    if (e.attempts >= MAX_ATTEMPTS && !e.tries.length) e.error = 'The robot has given up on this one, sorry.';
    this.ctx.update();
    if (this.s.closing && !this.#anyBusy()) this.#endCreate();
  }

  #pick(pid, matchupId, idx) {
    const { e } = this.#entry(pid, matchupId);
    if (!e || e.submitted || !e.tries[idx]) return;
    e.picked = idx;
    this.ctx.update();
  }

  #submit(pid, matchupId, idx) {
    const { e } = this.#entry(pid, matchupId);
    if (!e || e.submitted || this.s.closing) return;
    const i = Number.isInteger(idx) && e.tries[idx] ? idx : e.picked;
    if (i === null || i === undefined || !e.tries[i]) return;
    e.submitted = true;
    e.final = e.tries[i];
    e.picked = i;
    if (this.s.tallies[pid]) this.s.tallies[pid].picturesSubmitted += 1;
    this.ctx.sfx('submit');
    if (this.s.matchups.every((m) => m.authors.every((a) => m.entries[a].submitted))) this.#endCreate();
    else this.ctx.update();
  }

  #anyBusy() {
    return this.s.matchups.some((m) => Object.values(m.entries).some((e) => e.busy));
  }

  #doneAll(id) {
    return this.s.matchups.filter((m) => m.authors.includes(id)).every((m) => m.entries[id].submitted);
  }

  #closeCreate() {
    const s = this.s;
    if (s.phase !== 'create' || s.closing) return;
    if (!this.#anyBusy()) { this.#endCreate(); return; }
    s.closing = true;
    this.ctx.setTimer('createGrace', GRACE_MS);
    this.ctx.sayLine('pdCreateClosing', {});
    this.ctx.update();
  }

  #endCreate() {
    const s = this.s;
    if (s.phase !== 'create') return;
    this.ctx.clearTimer('create');
    this.ctx.clearTimer('createGrace');
    s.closing = false;
    for (const m of s.matchups) {
      for (const a of m.authors) {
        const e = m.entries[a];
        e.busy = null;
        if (!e.final && e.tries.length) e.final = e.tries[e.picked ?? e.tries.length - 1] || e.tries.at(-1);
        if (!e.final && s.tallies[a]) s.tallies[a].noAnswers += 1;
      }
      m.order = shuffle([...m.authors]);
    }
    this.ctx.sfx('buzzer');
    s.matchIdx = 0;
    this.#startVote();
  }

  // ---------------------------------------------------------------- voting
  #eligibleVoters(m) {
    const everyone = [...new Set([...this.s.roster, ...this.ctx.audienceIds()])];
    return everyone.filter((id) => !m.authors.includes(id) && this.ctx.isConnected(id));
  }

  #startVote() {
    const s = this.s;
    const m = s.matchups[s.matchIdx];
    if (!m) return this.#roundScores();
    if (m.authors.filter((a) => m.entries[a].final).length < 2) return this.#reveal();
    this.#phase('vote', ((this.ctx.timing.vote || 20) + 5) * 1000);
    this.ctx.music('voting');
    this.ctx.sfx('whoosh');
    if (s.matchIdx > 0 && Math.random() < 0.5) this.ctx.sayLine('votePreamble', {});
    this.ctx.sayLine('pdStarter', { prompt: m.prompt.text });
    this.ctx.buzz(this.#eligibleVoters(m), [40]);
    this.#botsVote();
    return undefined;
  }

  #vote(pid, matchupId, choice) {
    const m = this.s.matchups[this.s.matchIdx];
    if (!m || m.id !== matchupId || m.authors.includes(pid) || m.votes[pid]) return;
    const target = choice === 'A' ? m.order[0] : choice === 'B' ? m.order[1] : null;
    if (!target || !m.entries[target]?.final) return;
    m.votes[pid] = target;
    if (this.s.tallies[pid]) this.s.tallies[pid].votesCast += 1;
    this.ctx.sfx('vote');
    if (this.#eligibleVoters(m).every((id) => m.votes[id])) this.#reveal();
    else this.ctx.update();
  }

  #reveal() {
    const s = this.s;
    const m = s.matchups[s.matchIdx];
    if (!m || m.result) return;
    this.ctx.clearTimer('vote');
    const mult = s.round;
    const pool = 1000 * mult;
    const [a, b] = m.authors;
    const answered = m.authors.filter((x) => m.entries[x].final);
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
      [winner] = answered;
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
    m.result = { kind, winner, votes, points, total };
    this.#phase('reveal', REVEAL_MS);
    this.ctx.sfx('reveal');
    const loser = winner && m.authors.find((x) => x !== winner);
    this.ctx.sayLine(kind, { name: winner ? this.ctx.playerName(winner) : '', other: loser ? this.ctx.playerName(loser) : '' });
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
    const ranking = this.#ranking();
    const leader = ranking[0];
    const close = ranking.length > 1 && leader.score - ranking[1].score < 300;
    this.ctx.sayLine(close ? 'scoresClose' : 'scores', { leader: this.ctx.playerName(leader.id), last: this.ctx.playerName(ranking.at(-1).id) });
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
    const add = (key, hit) => {
      if (hit) out.push({ key, title: this.ctx.line(`award_${key}`) || key, playerId: hit.id, name: this.ctx.playerName(hit.id), value: hit.v });
    };
    add('crowd', best('votesReceived'));
    add('shutouts', best('shutouts'));
    add('artist', best('imagesGenerated', 3));
    add('ghost', best('noAnswers'));
    const second = ranking.find((r) => r.rank === 2);
    if (second) add('bridesmaid', { id: second.id, v: second.score });
    return out.slice(0, 4);
  }

  #allAnswers() {
    const s = this.s;
    const out = [];
    for (const m of [...s.history, ...s.matchups]) {
      for (const id of m.authors) {
        const f = m.entries[id]?.final;
        if (!f) continue;
        out.push({
          playerId: id, playerName: this.ctx.playerName(id), round: m.round, prompt: m.prompt.text,
          answer: f.prompt, votes: m.result?.votes?.[id] || 0, totalVotes: m.result?.total || 0,
          won: m.result?.winner === id, panic: false,
        });
      }
    }
    return out;
  }

  #finish() {
    const s = this.s;
    if (s.finished) return;
    s.finished = true;
    const ranking = this.#ranking();
    const answers = this.#allAnswers();
    const bestOf = (id) => answers.filter((a) => a.playerId === id && a.votes > 0).sort((x, y) => y.votes - x.votes)[0] || null;
    this.ctx.finish({
      gameType: meta.id,
      players: ranking.map((r) => ({ ...this.ctx.publicPlayer(r.id), score: r.score, rank: r.rank, counters: { ...s.tallies[r.id] }, best: bestOf(r.id) })),
      winnerIds: ranking.filter((r) => r.rank === 1 && r.score > 0).map((r) => r.id),
      answers,
      highlights: [...answers].filter((a) => a.votes > 0).sort((x, y) => y.votes - x.votes).slice(0, 5)
        .map((a) => ({ name: a.playerName, prompt: a.prompt, answer: a.answer, votes: a.votes, totalVotes: a.totalVotes })),
      awards: s.awards,
    });
  }

  // ------------------------------------------------------------------ bots
  #rand(min, max) { return min + Math.random() * (max - min); }

  #botPrompt(m) {
    return pick([
      `${m.prompt.text}, but make it dramatic`,
      `${m.prompt.text} in the style of a kids' crayon drawing`,
      this.ctx.content.panic(),
    ]);
  }

  #botsCreate() {
    for (const id of this.s.roster.filter((x) => this.ctx.isBot(x))) {
      for (const m of this.s.matchups.filter((x) => x.authors.includes(id))) this.#botNext(id, m.id, true);
    }
  }

  // A bot's next move on one brief: paint (once or twice), then send one in.
  #botNext(id, matchupId, first = false) {
    this.ctx.later(first ? this.#rand(2500, 9000) : this.#rand(1500, 4000), () => {
      const { m, e } = this.#entry(id, matchupId);
      if (!e || this.s.phase !== 'create' || e.submitted || e.busy) return;
      if (this.#busy(id)) { this.#botNext(id, matchupId); return; }
      if (!e.tries.length || (e.tries.length < 2 && Math.random() < 0.35)) this.#generate(id, matchupId, this.#botPrompt(m));
      else this.#submit(id, matchupId, Math.floor(Math.random() * e.tries.length));
    });
  }

  #botsVote() {
    const m = this.s.matchups[this.s.matchIdx];
    if (!m) return;
    for (const id of this.#eligibleVoters(m).filter((x) => this.ctx.isBot(x))) {
      this.ctx.later(this.#rand(2500, 7000), () => {
        if (this.s.phase === 'vote' && this.s.matchups[this.s.matchIdx]?.id === m.id) this.#vote(id, m.id, pick(['A', 'B']));
      });
    }
  }

  // ------------------------------------------------------------------ views
  #pub(id) { return this.ctx.publicPlayer(id); }
  #url(key) { return key ? this.ctx.media.url(key) : null; }

  #stableLine(key) {
    if (this.lineCache?.epoch !== this.epoch) this.lineCache = { epoch: this.epoch, lines: {} };
    this.lineCache.lines[key] ??= this.ctx.line(key) || '';
    return this.lineCache.lines[key];
  }

  #roundTitle() {
    return this.s.round ? this.ctx.line(`pdRoundTitle${this.s.round}`) || `Round ${this.s.round}` : null;
  }

  #scoreboard() {
    return this.#ranking().map((r) => ({ ...this.#pub(r.id), score: r.score, rank: r.rank, delta: r.delta }));
  }

  hostView() {
    const s = this.s;
    const base = {
      phase: s.phase, round: s.round, mult: Math.max(1, s.round), deadline: s.deadline, timer: TIMED.includes(s.phase) && !s.closing,
      timerTotal: s.timerMs, mode: meta.id, title: meta.name, roundTitle: this.#roundTitle(),
    };
    switch (s.phase) {
      case 'intro':
        return { ...base, tagline: meta.tagline, ai: !!this.ctx.images?.available() };
      case 'selfie':
        return { ...base, players: s.roster.map((id) => ({ ...this.#pub(id), done: !!s.selfies[id] })) };
      case 'loading':
        return { ...base, text: s.loadingText };
      case 'create':
        return {
          ...base, closing: !!s.closing,
          players: s.roster.map((id) => {
            const mine = s.matchups.filter((m) => m.authors.includes(id)).map((m) => m.entries[id]);
            return {
              ...this.#pub(id), done: mine.length > 0 && mine.every((e) => e.submitted),
              painting: mine.some((e) => e.busy), tries: mine.reduce((x, e) => x + e.tries.length, 0), maxTries: mine.length * MAX_TRIES,
            };
          }),
        };
      case 'vote': {
        const m = s.matchups[s.matchIdx];
        const voters = this.#eligibleVoters(m);
        return {
          ...base, prompt: m.prompt.text, stars: (m.prompt.stars || []).map((id) => this.#pub(id)), matchNo: s.matchIdx + 1, matchTotal: s.matchups.length,
          images: m.order.map((id, i) => ({ key: i ? 'B' : 'A', url: this.#url(m.entries[id].final?.key) })),
          voters: voters.map((v) => ({ ...this.#pub(v), done: !!m.votes[v] })),
        };
      }
      case 'reveal': {
        const m = s.matchups[s.matchIdx];
        const r = m.result;
        return {
          ...base, prompt: m.prompt.text, kind: r.kind, total: r.total, matchNo: s.matchIdx + 1, matchTotal: s.matchups.length,
          answers: m.order.map((id, i) => {
            const f = m.entries[id].final;
            return {
              key: i ? 'B' : 'A', url: this.#url(f?.key), imagePrompt: f?.prompt || null, usedRef: !!f?.ref, author: this.#pub(id),
              votes: r.votes[id] || 0, points: r.points[id] || 0, winner: r.winner === id,
              pct: r.total ? Math.round(((r.votes[id] || 0) / r.total) * 100) : 0,
              voters: Object.entries(m.votes).filter(([, v]) => v === id).map(([voter]) => this.#pub(voter)),
            };
          }),
        };
      }
      case 'scores':
        return { ...base, scoreboard: this.#scoreboard() };
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
      phase: s.phase, round: s.round, deadline: s.deadline, timer: TIMED.includes(s.phase) && !s.closing, timerTotal: s.timerMs,
      inGame, score: s.scores[pid] || 0, title: meta.name, roundTitle: this.#roundTitle(),
    };
    const watch = (key) => ({ ...base, screen: 'watch', text: this.#stableLine(key), textKey: key });
    switch (s.phase) {
      case 'intro':
        return watch('phoneIntro');
      case 'selfie':
        return inGame ? { ...base, screen: 'selfie', done: !!s.selfies[pid] } : watch('phoneIntro');
      case 'loading':
        return watch('phonePdLoading');
      case 'create': {
        if (!inGame) return watch('phoneAudienceWriting');
        const mine = s.matchups.filter((m) => m.authors.includes(pid));
        const m = mine.find((x) => !x.entries[pid].submitted);
        if (!m) return watch('phonePdSubmitted');
        const e = m.entries[pid];
        if (s.closing && !e.busy) return watch('phonePdSubmitted');
        return {
          ...base, screen: 'create', matchupId: m.id, prompt: m.prompt.text, index: mine.indexOf(m) + 1, total: mine.length,
          stars: (m.prompt.stars || []).map((id) => ({ ...this.#pub(id), photo: this.#pub(id).photo || null })),
          tries: e.tries.map((t) => ({ url: this.#url(t.key), prompt: t.prompt, ref: !!t.ref })),
          picked: e.picked, busy: e.busy ? { prompt: e.busy.prompt, at: e.busy.at } : null, error: e.error,
          triesLeft: Math.max(0, Math.min(MAX_TRIES - e.tries.length, MAX_ATTEMPTS - e.attempts)), maxTries: MAX_TRIES,
          maxChars: PROMPT_CHARS, closing: !!s.closing, ai: !!this.ctx.images?.available(),
        };
      }
      case 'vote': {
        const m = s.matchups[s.matchIdx];
        if (m.authors.includes(pid)) return watch('phonePdYourMatchup');
        if (m.votes[pid]) return watch('phonePdVoted');
        return {
          ...base, screen: 'vote', matchupId: m.id, prompt: m.prompt.text,
          options: m.order.map((id, i) => ({ id: i ? 'B' : 'A', url: this.#url(m.entries[id].final?.key) })),
        };
      }
      case 'reveal': {
        const m = s.matchups[s.matchIdx];
        if (!m.authors.includes(pid)) return watch('phoneWatchReveal');
        const won = m.result.winner === pid;
        return { ...watch(won ? 'phoneWon' : m.result.winner ? 'phoneLost' : 'phoneDraw'), mood: won ? 'win' : 'lose', gained: m.result.points[pid] || 0 };
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
}
