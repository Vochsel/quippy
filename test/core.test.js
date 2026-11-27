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

test('a 13-player crowd answers one prompt each, so rounds stay short', async (t) => {
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
  assert.equal(matchups.length, 7, 'ceil(13 / 2) matchups');
  for (const id of roster) assert.ok(matchups.some((m) => m.authors.includes(id)), 'everyone has a prompt');
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
        return { answers: Object.fromEntries(items.map((i) => [i.key, `AI ${i.style.split(' ')[0]}`])) };
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
