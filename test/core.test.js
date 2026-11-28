// Fast checks for the shared core: run with `npm test`.
// Whole games are simulated with bots and mocked timers, so a 4-minute game
// finishes in well under a second.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mock, test } from 'node:test';

import { PACKS } from '../content/index.js';
import { buildConfig } from '../core/config.js';
import { ContentLibrary } from '../core/content.js';
import { extractJson, LLM } from '../core/llm.js';
import { heuristicLoreUpdate } from '../core/lore.js';
import { applyGameResult, emptyStats } from '../core/profiles.js';
import { Room } from '../core/room.js';
import { SqlStore } from '../core/sqlstore.js';
import { GAMES } from '../games/registry.js';

function memoryStore() {
  const db = new DatabaseSync(':memory:');
  return new SqlStore({
    all: async (sql, p) => db.prepare(sql).all(...p),
    get: async (sql, p) => db.prepare(sql).get(...p) ?? null,
    run: async (sql, p) => db.prepare(sql).run(...p),
  });
}

function makeDeps(store, saved) {
  const config = buildConfig({ LLM_PROVIDER: 'none' });
  return {
    store, config, llm: new LLM(config.llm), content: new ContentLibrary(PACKS, 'en-AU'),
    joinUrl: (c) => `http://test/${c}`, log: () => {},
    persist: async (snap) => { saved.last = structuredClone(snap); },
  };
}

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

async function advance(room, until, maxTicks = 4000) {
  for (let i = 0; i < maxTicks; i++) {
    mock.timers.tick(250);
    await flush();
    if (until(room)) return true;
  }
  return false;
}

test('extractJson tolerates fences and <think> blocks', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('<think>hmm {"no":1}</think>\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Sure! {"prompts":[{"text":"x } y"}]} Hope that helps'), { prompts: [{ text: 'x } y' }] });
  assert.equal(extractJson('no json here'), null);
});

test('content packs: locale fallback, family filter, host lines', () => {
  const lib = new ContentLibrary(PACKS, 'en-AU');
  assert.equal(lib.resolveLocale('en-NZ'), 'en-AU');
  assert.equal(lib.resolveLocale('fr-FR'), 'en-AU');
  const adult = lib.forRoom({ locale: 'en-AU', family: false });
  const family = lib.forRoom({ locale: 'en-AU', family: true });
  assert.ok(adult.prompts.length >= 500, 'big prompt bank');
  assert.ok(family.prompts.every((p) => !p.tags.includes('spicy')));
  assert.ok(family.prompts.length < adult.prompts.length);
  assert.ok(adult.personal.every((p) => p.text.includes('{player}')));
  assert.equal(new Set(adult.prompts.map((p) => p.key)).size, adult.prompts.length, 'prompt keys are unique');
  assert.match(adult.line('join', { name: 'Bazza' }), /Bazza/);
  const used = new Set(adult.prompts.slice(0, 600).map((p) => p.key));
  const picked = adult.pickPrompts(5, used);
  assert.equal(picked.length, 5);
  assert.ok(picked.every((p) => !used.has(p.key)), 'unseen prompts preferred');
});

test('lifetime stats fold in a game result', () => {
  let s = emptyStats();
  s = applyGameResult(s, { score: 3000, rank: 1, counters: { shutouts: 2, votesReceived: 7 }, best: { prompt: 'p', answer: 'a', votes: 4, totalVotes: 5 } }, 'zinger-duel', true);
  s = applyGameResult(s, { score: 1000, rank: 3, counters: { shutouts: 1, votesReceived: 2 } }, 'zinger-duel', false);
  assert.equal(s.gamesPlayed, 2);
  assert.equal(s.gamesWon, 1);
  assert.equal(s.points, 4000);
  assert.equal(s.counters.shutouts, 3);
  assert.equal(s.byGame['zinger-duel'].played, 2);
  assert.equal(s.bestAnswer.answer, 'a');
  assert.equal(s.winStreak, 0);
  assert.equal(s.bestWinStreak, 1);
});

test('heuristic lore promotes top answers and decays old jokes', () => {
  const lore = heuristicLoreUpdate({ jokes: [{ id: 'x', title: 'Old bit', heat: 1 }] }, [
    { playerName: 'Bazza', prompt: 'P', answer: 'A legendary servo pie', votes: 4, totalVotes: 4 },
    { playerName: 'Shazza', prompt: 'P', answer: 'Meh', votes: 0, totalVotes: 4 },
  ]);
  assert.equal(lore.jokes[0].title, 'A legendary servo pie');
  assert.ok(!lore.jokes.find((j) => j.title === 'Old bit'), 'cold jokes fall out');
  assert.equal(lore.gamesSeen, 1);
});

// Every registered game must be playable start-to-finish by bots. If a new
// game fails here, give its bots something to do (see ctx.isBot / ctx.later).
for (const { id: gameType, minPlayers } of GAMES) {
  test(`${gameType}: a full bot game runs start to finish and is recorded`, async (t) => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.after(() => mock.timers.reset());
    const store = memoryStore();
    const saved = {};
    const room = new Room({ code: 'TEST', crewId: 'h_testcrew01', deps: makeDeps(store, saved) });
    await room.init();
    const bots = Math.max(4, minPlayers);
    for (let i = 0; i < bots; i++) room.addBot();
    await room.startGame(gameType);
    assert.ok(room.game, 'game started');
    const done = await advance(room, (r) => !r.game && r.lastResults);
    assert.ok(done, 'game finished');
    mock.timers.tick(1000); // let the debounced save land
    await flush(20);
    const res = room.lastResults;
    assert.equal(res.players.length, bots);
    assert.ok(res.players.some((p) => p.score > 0), 'someone scored');
    assert.equal(room.session.games, 1);
    const games = await store.all('SELECT game_type FROM games');
    assert.deepEqual(games.map((g) => g.game_type), [gameType]);
    assert.equal(saved.last.game, null, 'snapshot back in the lobby');
  });
}

test('a big crowd (13) still answers two prompts each in rounds 1 and 2', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const store = memoryStore();
  const room = new Room({ code: 'BIGG', crewId: 'h_testcrew01', deps: makeDeps(store, {}) });
  await room.init();
  for (let i = 0; i < 13; i++) room.addBot();
  await room.startGame('zinger-duel');
  const started = await advance(room, (r) => r.game?.s?.matchups?.length);
  assert.ok(started, 'round 1 dealt');
  const { matchups, roster } = room.game.s;
  assert.equal(roster.length, 13);
  assert.equal(matchups.length, 13, 'one matchup per player');
  for (const id of roster) assert.equal(matchups.filter((m) => m.authors.includes(id)).length, 2, 'everyone has two prompts');
  for (const m of matchups) assert.notEqual(m.authors[0], m.authors[1]);
  const done = await advance(room, (r) => !r.game && r.lastResults);
  assert.ok(done, 'game finished');
  assert.equal(room.lastResults.players.length, 13);
});

test('solo mode: AI bots write their own answers and vote with the judge', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const store = memoryStore();
  const deps = makeDeps(store, {});
  const calls = [];
  deps.llm = {
    available: () => true, status: () => ({ available: true }), label: 'fake', model: 'fake',
    async json({ system, user }) {
      const items = JSON.parse(user);
      if (system.includes('answers for bot players')) {
        calls.push('answers');
        return { answers: Object.fromEntries(items.map((i) => [i.key, `AI ${i.style.split(' ')[0]} ${i.key}`])) };
      }
      if (system.includes('You judge')) {
        calls.push('judge');
        return { rankings: Object.fromEntries(items.map((i) => [i.key, i.options.map((_, n) => n).reverse()])) };
      }
      throw new Error('not used here');
    },
  };
  const room = new Room({ code: 'SOLO', crewId: 'h_testcrew01', deps });
  await room.init();
  for (let i = 0; i < 4; i++) room.addBot();
  await room.startGame('zinger-duel');
  const voting = await advance(room, (r) => r.game?.s?.phase === 'vote' && r.game.s.botPicks);
  assert.ok(voting, 'judge picked before voting ended');
  const answers = room.game.s.matchups.flatMap((m) => Object.values(m.answers).map((a) => a.text));
  assert.ok(answers.length >= 4 && answers.every((a) => a.startsWith('AI ')), `AI answers: ${answers}`);
  const done = await advance(room, (r) => !r.game && r.lastResults);
  assert.ok(done, 'game finished');
  assert.ok(calls.includes('answers') && calls.includes('judge'));
  assert.ok(calls.filter((c) => c === 'answers').length <= 3, 'one answer call per round');
});

test('the TV can kick someone mid-game; the game carries on and forgets them', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const room = new Room({ code: 'KICK', crewId: 'h_testcrew01', deps: makeDeps(memoryStore(), {}) });
  await room.init();
  for (let i = 0; i < 4; i++) room.addBot();
  await room.startGame('zinger-duel');
  const victim = room.gameMeta.roster[0];
  const tv = { role: 'host', isOwner: true, send: () => {} };
  const phone = { role: 'player', playerId: room.gameMeta.roster[1], send: () => {} };
  await room.onMessage(phone, { t: 'action', a: 'kick', playerId: victim });
  assert.ok(room.players.get(victim) && !room.players.get(victim).kicked, 'a phone cannot kick');
  await room.onMessage(tv, { t: 'action', a: 'kick', playerId: victim });
  assert.ok(room.players.get(victim).kicked, 'kicked mid-game');
  assert.ok(!room.publicPlayers().some((p) => p.id === victim), 'hidden from views');
  const done = await advance(room, (r) => !r.game && r.lastResults);
  assert.ok(done, 'game still finished');
  assert.ok(!room.players.has(victim), 'forgotten after the game');
});

test('a game snapshot resumes mid-round in a fresh Room (restart survival)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const store = memoryStore();
  const saved = {};
  const room = new Room({ code: 'RSTR', crewId: 'h_testcrew02', deps: makeDeps(store, saved) });
  await room.init();
  for (let i = 0; i < 3; i++) room.addBot();
  await room.startGame('zinger-duel');
  assert.ok(await advance(room, (r) => r.game?.s.phase === 'vote'), 'reached voting');
  await room.saveNow();
  const snap = structuredClone(saved.last);
  assert.equal(snap.game.phase, 'vote');

  // "Crash": drop the old room's timers on the floor and build a new one from the snapshot.
  for (const tmr of room.timers.values()) clearTimeout(tmr.handle);
  for (const h of room.laters) clearTimeout(h);
  room.game = null;
  const revived = new Room({ code: 'RSTR', crewId: 'h_testcrew02', deps: makeDeps(store, saved), snapshot: snap });
  await revived.init();
  assert.equal(revived.game.s.phase, 'vote');
  assert.equal(revived.game.s.matchIdx, snap.game.matchIdx);
  const done = await advance(revived, (r) => !r.game && r.lastResults);
  assert.ok(done, 'revived game finished');
});

test('someone who missed the deal is added at the next round', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const store = memoryStore();
  const saved = {};
  const room = new Room({ code: 'LATE', crewId: 'h_testcrew03', deps: makeDeps(store, saved) });
  await room.init();
  for (let i = 0; i < 3; i++) room.addBot();
  await room.startGame('zinger-duel');
  assert.ok(await advance(room, (r) => r.game?.s.round === 1 && r.game?.s.phase === 'answer'));
  room.addBot(); // arrives during round 1
  const late = [...room.players.keys()].at(-1);
  assert.ok(!room.game.s.roster.includes(late));
  assert.ok(await advance(room, (r) => r.game?.s.round === 2 && r.game?.s.phase === 'answer'), 'reached round 2');
  assert.ok(room.game.s.roster.includes(late), 'late player dealt in at round 2');
  assert.ok(room.game.s.matchups.some((m) => m.authors.includes(late)), 'late player has prompts');
  assert.ok(await advance(room, (r) => !r.game && r.lastResults), 'game still finishes');
  assert.equal(room.lastResults.players.length, 4);
});

test('picture-duel: visual briefs pack', () => {
  const lib = new ContentLibrary(PACKS, 'en-AU');
  const adult = lib.forRoom({ locale: 'en-AU', family: false });
  const family = lib.forRoom({ locale: 'en-AU', family: true });
  assert.ok(adult.pictures.length >= 80, 'at least 80 briefs');
  assert.equal(new Set(adult.pictures.map((p) => p.key)).size, adult.pictures.length, 'brief keys are unique');
  assert.ok(family.pictures.every((p) => !p.tags.includes('spicy')));
  assert.equal(adult.pickPictures(3, new Set()).length, 3);
});

test('picture-duel: odd players, cost guards, restart mid-create, no paid calls for bots', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const store = memoryStore();
  const saved = {};
  const calls = [];
  // A fake paid model: counts calls, answers with a tiny "JPEG".
  const images = {
    available: () => true,
    generate: async ({ prompt }) => { calls.push(prompt); return { bytes: new Uint8Array([0xff, 0xd8, 1, 2]), type: 'image/jpeg', ms: 1 }; },
  };
  const deps = { ...makeDeps(store, saved), images };
  const room = new Room({ code: 'PICS', crewId: 'h_testcrew04', deps });
  await room.init();
  for (let i = 0; i < 5; i++) room.addBot();
  // One "human" (a bot entry flipped to human so it never acts by itself).
  const human = [...room.players.keys()][0];
  room.players.get(human).isBot = false;
  await room.startGame('picture-duel');
  assert.ok(await advance(room, (r) => r.game?.s.phase === 'create'), 'reached create');
  const g = room.game;
  const mine = g.s.matchups.filter((m) => m.authors.includes(human));
  assert.ok(mine.length >= 1);
  assert.ok(g.s.matchups.every((m) => m.authors.length === 2), 'pairs only');
  assert.equal(g.s.matchups.length, 3, '5 players -> 3 pairs (one player draws twice)');
  const mid = mine[0].id;
  for (let i = 0; i < 6; i++) {
    g.onAction(human, { type: 'generate', matchupId: mid, prompt: `try ${i}` });
    g.onAction(human, { type: 'generate', matchupId: mid, prompt: 'while busy' }); // ignored: one at a time
    await flush(10);
  }
  const e = mine[0].entries[human];
  assert.equal(e.tries.length, 3, 'max 3 pictures per brief');
  assert.equal(calls.length, 3, 'only the human hit the paid model');
  assert.ok(e.tries.every((x) => /^gen\/[\w-]+\.jpg$/.test(x.key)), 'state keeps media keys, not bytes');
  assert.ok(!JSON.stringify(g.serialize()).includes('base64'));
  assert.ok(await room.deps.media.get(e.tries[0].key), 'bytes are in the media store');

  // Restart mid-create: the revived game keeps the pictures and finishes.
  await room.saveNow();
  const snap = structuredClone(saved.last);
  for (const tmr of room.timers.values()) clearTimeout(tmr.handle);
  for (const h of room.laters) clearTimeout(h);
  room.game = null;
  const revived = new Room({ code: 'PICS', crewId: 'h_testcrew04', deps: { ...deps, media: room.deps.media }, snapshot: snap });
  await revived.init();
  assert.equal(revived.game.s.phase, 'create');
  assert.ok(await advance(revived, (r) => !r.game && r.lastResults), 'revived game finished');
  const res = revived.lastResults;
  assert.equal(res.players.length, 5);
  assert.equal(calls.length, 3, 'still no paid calls from bots');
});

test('pausing freezes the game; resuming carries on to the end', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const store = memoryStore();
  const saved = {};
  const room = new Room({ code: 'PAUS', crewId: 'h_testcrew04', deps: makeDeps(store, saved) });
  await room.init();
  for (let i = 0; i < 3; i++) room.addBot();
  await room.startGame('zinger-duel');
  assert.ok(await advance(room, (r) => r.game?.s.phase === 'vote' && !r.game.s.reading), 'voting open');
  const where = `${room.game.s.round}|${room.game.s.matchIdx}|${room.game.s.phase}`;
  room.pause();
  await advance(room, () => false, 800); // 200s of nothing
  assert.equal(`${room.game.s.round}|${room.game.s.matchIdx}|${room.game.s.phase}`, where, 'nothing moved while paused');
  room.unpause();
  assert.ok(await advance(room, (r) => !r.game && r.lastResults), 'finished after resuming');
});

// Browser code never runs under node:test, so at least make sure every client
// module parses (a duplicate declaration blanks the whole page).
test('browser modules parse', async () => {
  const { readdirSync, readFileSync, writeFileSync, mkdtempSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dirs = ['public/js', 'public/js/lib', ...readdirSync('games').map((g) => `games/${g}/client`)];
  const tmp = mkdtempSync(join(tmpdir(), 'quippy-parse-'));
  const bad = [];
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.js')); } catch { continue; }
    for (const f of files) {
      const copy = join(tmp, 'm.mjs');
      writeFileSync(copy, readFileSync(join(dir, f)));
      const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(`${dir}/${f}: ${(r.stderr.match(/SyntaxError.*/) || [r.stderr])[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('host tones: lines switch with the tone, spicy tones are off in family mode', async () => {
  const { effectiveTone, TONES } = await import('../core/tones.js');
  const lib = new ContentLibrary(PACKS, 'en-AU');
  const base = new Set(lib.pack('en-AU').host.win);
  for (const t of TONES.filter((x) => x.id !== 'normal')) {
    const lines = lib.pack('en-AU').tones[t.id];
    assert.ok(lines && Object.keys(lines).length > 40, `${t.id} pack loaded`);
    const said = lib.forRoom({ locale: 'en-AU', tone: t.id }).line('win', { name: 'Ann', other: 'Bob' });
    assert.ok(said && !said.includes('{'), `${t.id} fills placeholders`);
    // Every toned line uses only placeholders its event already had.
    const host = lib.pack('en-AU').host;
    for (const [k, list] of Object.entries(lines)) {
      const allowed = new Set((host[k] || []).flatMap((x) => x.match(/\{\w+\}/g) || []));
      for (const line of list) for (const hole of line.match(/\{\w+\}/g) || []) assert.ok(allowed.has(hole), `${t.id}.${k}: ${hole}`);
    }
  }
  assert.ok(!base.has(lib.forRoom({ locale: 'en-AU', tone: 'therapist' }).line('win', { name: 'A', other: 'B' })));
  assert.equal(effectiveTone('sexy', true).id, 'normal');
  assert.equal(effectiveTone('chaplain', true).id, 'normal');
  assert.equal(effectiveTone('therapist', true).id, 'therapist');
  assert.equal(effectiveTone('nonsense', false).id, 'normal');
});

test('double-take: selfies, secret captions, painting retries, cost guard, restart mid-game', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const store = memoryStore();
  const saved = {};
  const files = new Map();
  const media = { get: async (k) => files.get(k) || null, put: async (k, b) => { files.set(k, b); } };
  const calls = [];
  let failures = 2;
  // A fake paid model: the first two calls fail, the rest answer with a tiny "JPEG".
  const images = {
    available: () => true,
    generate: async ({ prompt, references }) => {
      calls.push({ prompt, refs: references?.length || 0 });
      if (failures-- > 0) throw new Error('boom');
      return { bytes: new Uint8Array([0xff, 0xd8, 1, 2]), type: 'image/jpeg', ms: 1 };
    },
  };
  const deps = { ...makeDeps(store, saved), images, media };
  const room = new Room({ code: 'DUBS', crewId: 'h_testcrew05', deps });
  await room.init();
  for (let i = 0; i < 4; i++) room.addBot();
  // Two "humans" (bot entries flipped so they never act by themselves); one has a selfie.
  const [h1, h2] = [...room.players.keys()];
  for (const id of [h1, h2]) room.players.get(id).isBot = false;
  room.players.get(h1).photo = 'dev_h1abcd-0123abcd.jpg';
  files.set('photos/dev_h1abcd-0123abcd.jpg', new Uint8Array([0xff, 0xd8, 9]));
  await room.startGame('double-take');
  assert.ok(await advance(room, (r) => r.game?.s.phase === 'selfie'), 'selfie step');
  const g = room.game;
  assert.equal(g.hostView().players.length, 4);
  assert.equal(g.playerView(h1).screen, 'selfie');
  g.onAction(h1, { type: 'selfieDone' });
  g.onAction(h2, { type: 'selfieDone' });
  assert.ok(await advance(room, (r) => r.game?.s.phase === 'guess'), 'first question up');

  const q = g.s.questions[0];
  assert.equal(g.s.questions.length, 5);
  for (const x of g.s.questions) {
    assert.equal(x.options.length, 4);
    assert.equal(new Set(x.options.map((o) => o.text)).size, 4, 'four different captions');
    assert.equal(new Set(x.real).size, 2);
    const faces = new Set(x.real.flatMap((i) => x.options[i].stars));
    assert.ok(x.options.every((o) => o.stars.every((id) => faces.has(id))), 'decoys star the same faces');
  }
  // Nothing in the views says which captions are real before the reveal.
  const hv = g.hostView();
  const pv = g.playerView(h1);
  assert.deepEqual(hv.captions, q.options.map((o) => o.text));
  assert.deepEqual(pv.options, q.options.map((o) => o.text));
  for (const v of [hv, pv]) assert.ok(!/"(real|stars|template)"/.test(JSON.stringify(v)), 'no secrets in views');
  assert.ok(q.slots.every((s) => /^gen\/[\w-]+\.jpg$/.test(s.key)), 'state keeps media keys');
  assert.ok(q.slots.some((s) => s.tries === 2), 'a failed picture was retried');
  assert.ok(calls.some((c) => c.refs === 1 && /reference photo shows/.test(c.prompt)) || !g.s.questions.some((x) => x.real.some((i) => x.options[i].stars.includes(h1))), 'selfie used as a reference');

  const decoys = [0, 1, 2, 3].filter((i) => !q.real.includes(i));
  g.onAction(h1, { type: 'picks', qId: q.id, picks: [decoys[0]] });
  g.onAction(h1, { type: 'picks', qId: q.id, picks: [...q.real, 99] });
  g.onAction(h2, { type: 'picks', qId: q.id, picks: decoys });
  assert.ok(await advance(room, (r) => r.game?.s.phase === 'reveal'), 'reveal');
  assert.equal(g.s.scores[h1], 1250, '2 right + Double Take bonus');
  assert.equal(g.s.scores[h2], 0);
  assert.equal(g.playerView(h1).right, 2);
  assert.ok(g.hostView().captions.filter((c) => c.real).length === 2, 'reveal shows the real two');

  // Restart: the revived game re-queues anything unfinished and plays to the end.
  await room.saveNow();
  const snap = structuredClone(saved.last);
  for (const tmr of room.timers.values()) clearTimeout(tmr.handle);
  for (const h of room.laters) clearTimeout(h);
  room.game.dead = true;
  room.game = null;
  const revived = new Room({ code: 'DUBS', crewId: 'h_testcrew05', deps, snapshot: snap });
  await revived.init();
  assert.equal(revived.game.s.phase, 'reveal');
  const final = revived.game.s;
  assert.ok(await advance(revived, (r) => !r.game && r.lastResults), 'revived game finished');
  assert.ok(calls.length <= 12, `cost guard (${calls.length} paid calls)`);
  const res = revived.lastResults;
  assert.equal(res.players.length, 4);
  assert.ok(final.tallies[h1].doubleTakes >= 1);
  assert.ok(final.tallies[h1].answerTimed >= 1 && final.tallies[h1].votesCast >= 2);
  assert.equal(final.tallies[h2].questionsPlayed, 5);
  assert.ok(res.awards.length >= 1);
});

test('picture model is a room setting (Flare by default, Sunburst switchable)', async () => {
  const { IMAGE_MODELS } = await import('../core/images.js');
  const deps = makeDeps(memoryStore(), {});
  const seen = [];
  deps.images = { available: () => true, status: () => ({}), generate: async (o) => { seen.push(o.model); return null; } };
  const room = new Room({ code: 'PICS', crewId: 'h_testcrew01', deps });
  await room.init();
  const ctx = room.makeCtx({ id: 'picture-duel' });
  await ctx.images.generate({ prompt: 'x' });
  const tv = { role: 'host', isOwner: true, send: () => {} };
  await room.onMessage(tv, { t: 'action', a: 'settings', settings: { imageModel: 'openai/gpt-image-2.5-sunburst' } });
  await ctx.images.generate({ prompt: 'x' });
  await room.onMessage(tv, { t: 'action', a: 'settings', settings: { imageModel: 'evil/model' } });
  assert.deepEqual(seen, [null, 'openai/gpt-image-2.5-sunburst']);
  assert.equal(room.settings.imageModel, 'openai/gpt-image-2.5-sunburst', 'unknown models are ignored');
  assert.equal(IMAGE_MODELS[0].id, 'openai/gpt-image-2.5-flare');
  assert.equal(buildConfig({}).image.model, 'openai/gpt-image-2.5-flare');
});

test('final round is a medal vote: gold 900, silver 600, bronze 300 (+ winner bonus)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const room = new Room({ code: 'GOLD', crewId: 'h_testcrew01', deps: makeDeps(memoryStore(), {}) });
  await room.init();
  for (let i = 0; i < 5; i++) room.addBot();
  await room.startGame('zinger-duel');
  const voting = await advance(room, (r) => r.game?.s?.phase === 'finalVote' && !r.game.s.final.reading);
  assert.ok(voting, 'reached the final vote');
  const g = room.game; const f = g.s.final;
  assert.equal(f.votesPer, 3, 'three medals each');
  const [a, b, c, d] = f.order;
  const before = { ...g.s.scores };
  const fk = (id) => `f${f.order.indexOf(id)}`;
  f.done = {}; f.votes = {};
  // Two voters: a gets gold+gold, b silver+bronze, c bronze+silver. d votes too.
  g.onAction(d, { type: 'finalVote', picks: [fk(a), fk(b), fk(c)] });
  g.onAction(c, { type: 'finalVote', picks: [fk(a), fk(c), fk(b)] }); // own answer is ignored
  assert.deepEqual(f.votes[c], [a, b], 'own answer dropped, order kept');
  g.finalReveal();
  const r = f.result;
  assert.deepEqual(r.medals[a], { gold: 2, silver: 0, bronze: 0 });
  assert.equal(r.votes[a], 6);
  assert.equal(r.points[a], 6 * 300 + 300, 'two golds + winner bonus');
  assert.equal(r.votes[b], 2 + 2, 'silver + silver (c\'s list shifted up)');
  assert.equal(r.points[c], 1 * 300, 'one bronze');
  assert.deepEqual(r.winners, [a]);
  assert.equal(r.ascending.at(-1), a, 'winner revealed last');
  assert.equal(g.s.scores[a] - before[a], r.points[a]);
  const view = g.hostView();
  assert.ok(view.answers.some((x) => x.medals.gold === 2));
});

test('identical answers are allowed by default', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const room = new Room({ code: 'SAMD', crewId: 'h_testcrew01', deps: makeDeps(memoryStore(), {}) });
  await room.init();
  assert.equal(room.settings.noDuplicates, false);
  for (let i = 0; i < 4; i++) room.addBot();
  await room.startGame('zinger-duel');
  assert.ok(await advance(room, (r) => r.game?.s?.phase === 'answer'));
  const g = room.game; const m = g.s.matchups[0]; const [a, b] = m.authors;
  m.answers = {};
  g.onAction(a, { type: 'answer', matchupId: m.id, text: 'Wet bread' });
  g.onAction(b, { type: 'answer', matchupId: m.id, text: 'wet bread' });
  assert.equal(m.answers[b]?.text, 'wet bread');
});

test('with "no copycat answers" on, identical answers bounce back to rethink', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const room = new Room({ code: 'SAME', crewId: 'h_testcrew01', deps: makeDeps(memoryStore(), {}) });
  await room.init();
  await room.onMessage({ role: 'host', isOwner: true, send: () => {} }, { t: 'action', a: 'settings', settings: { noDuplicates: true } });
  assert.equal(room.settings.noDuplicates, true);
  for (let i = 0; i < 4; i++) room.addBot();
  await room.startGame('zinger-duel');
  const answering = await advance(room, (r) => r.game?.s?.phase === 'answer');
  assert.ok(answering);
  const g = room.game;
  const m = g.s.matchups[0];
  const [a, b] = m.authors;
  m.answers = {};
  g.onAction(a, { type: 'answer', matchupId: m.id, text: 'A very confident emu' });
  g.onAction(b, { type: 'answer', matchupId: m.id, text: '  a VERY confident emu!! ' });
  assert.ok(!m.answers[b], 'duplicate not accepted');
  const pv = g.playerView(b);
  assert.equal(pv.screen, 'answer');
  assert.equal(pv.retry?.text, 'a VERY confident emu!!', 'their text comes back to edit');
  g.onAction(b, { type: 'answer', matchupId: m.id, text: 'A deeply insecure emu' });
  assert.equal(m.answers[b]?.text, 'A deeply insecure emu');
  assert.ok(!g.s.retry?.[b], 'retry cleared once accepted');
  // Panic suggestions differ between the two players on a prompt.
  const pa = g.playerView(a); // a has another prompt or is done; check panic map directly
  const picks = Object.entries(g.s.panicPicks || {}).filter(([k]) => k.endsWith(`|${m.id}`)).map(([, v]) => v);
  assert.equal(new Set(picks).size, picks.length, 'no shared panic lines');
  void pa;
  // Final round: same rule across everyone.
  const finalReady = await advance(room, (r) => r.game?.s?.phase === 'finalAnswer');
  assert.ok(finalReady);
  const f = g.s.final;
  f.answers = {};
  const [x, y] = g.s.roster;
  g.onAction(x, { type: 'answer', matchupId: 'final', text: 'Wet bread' });
  g.onAction(y, { type: 'answer', matchupId: 'final', text: 'wet. bread.' });
  assert.ok(!f.answers[y], 'final duplicate bounced');
  assert.equal(g.playerView(y).retry?.text, 'wet. bread.');
  const done = await advance(room, (r) => !r.game && r.lastResults);
  assert.ok(done, 'game still finishes (bots re-roll their own duplicates)');
});
