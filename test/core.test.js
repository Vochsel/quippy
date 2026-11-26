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
