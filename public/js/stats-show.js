// The crew stats show: a fullscreen, self-playing run of animated slides built
// from everything this crew has played (GET /api/rooms/:code/stats). Opened
// from the TV lobby's "📊 Stats" button. Click / → to skip, ← back, Esc closes.
import { avatar } from './lib/avatar.js';
import { fmt, h, mountInto } from './lib/dom.js';
import { api } from './lib/net.js';

const SLIDE_MS = 8000;

const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
const per = (a, b) => (b ? a / b : 0);

function countUp(el, to, ms = 1400, format = fmt) {
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    el.textContent = format(Math.round(to * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return el;
}

// Horizontal bars that grow in one after another.
function bars(rows, { value, label, max, unit = '' }) {
  const top = max ?? Math.max(1, ...rows.map(value));
  return h('div.ss-bars', rows.map((p, i) => {
    const fill = h('div.ss-fill', { style: { background: p.color, transitionDelay: `${0.25 + i * 0.12}s` } });
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${Math.max(3, (value(p) / top) * 100)}%`; }));
    return h('div.ss-bar', { style: { animationDelay: `${i * 0.12}s` } },
      avatar(p, '3rem'), h('span.ss-name', p.name), h('div.ss-track', fill),
      h('span.ss-val', label ? label(p) : `${fmt(value(p))}${unit}`));
  }));
}

function awards(players) {
  const c = (p, k) => p.c?.[k] || 0;
  const list = [];
  const best = (title, emoji, pool, score, text, low = false) => {
    const ranked = pool.filter((p) => Number.isFinite(score(p))).sort((a, b) => (low ? score(a) - score(b) : score(b) - score(a)));
    const p = ranked[0];
    if (p && (low || score(p) > 0)) list.push({ title, emoji, p, text: text(p) });
  };
  const timed = players.filter((p) => c(p, 'answerTimed') >= 2);
  best('Speed Demon', '⚡', timed, (p) => per(c(p, 'answerMs'), c(p, 'answerTimed')), (p) => `${sec(per(c(p, 'answerMs'), c(p, 'answerTimed')))} average reply`, true);
  best('Last-Gasp Merchant', '⏰', players, (p) => c(p, 'lastGasps'), (p) => `${c(p, 'lastGasps')} answers in the final 5 seconds`);
  best('Shutout King', '👑', players, (p) => c(p, 'shutouts'), (p) => `${c(p, 'shutouts')} shutouts`);
  best('Crowd Pleaser', '🎉', players.filter((p) => c(p, 'matchupsPlayed') >= 3), (p) => per(c(p, 'votesReceived'), c(p, 'matchupsPlayed') + c(p, 'answersWritten')),
    (p) => `${fmt(c(p, 'votesReceived'))} votes received`);
  best('Panic Merchant', '🆘', players, (p) => c(p, 'panics'), (p) => `hit the panic button ${c(p, 'panics')} times`);
  best('The Ghost', '👻', players, (p) => c(p, 'noAnswers'), (p) => `${c(p, 'noAnswers')} blank answers`);
  best('Wordsmith', '📜', players.filter((p) => (p.answers || 0) >= 3), (p) => p.avgLen || 0, (p) => `${p.avgLen} characters per answer`);
  best('Haiku Master', '✂️', players.filter((p) => (p.answers || 0) >= 3), (p) => p.avgLen || Infinity, (p) => `just ${p.avgLen} characters per answer`, true);
  best('Generous Voter', '🗳️', players, (p) => c(p, 'votesCast'), (p) => `${fmt(c(p, 'votesCast'))} votes cast`);
  best('Quick Draw Voter', '🔫', players.filter((p) => c(p, 'voteTimed') >= 3), (p) => per(c(p, 'voteMs'), c(p, 'voteTimed')), (p) => `votes in ${sec(per(c(p, 'voteMs'), c(p, 'voteTimed')))} on average`, true);
  return list;
}

function slides(stats) {
  const ps = stats.players;
  const c = (p, k) => p.c?.[k] || 0;
  const sum = (k) => ps.reduce((a, p) => a + c(p, k), 0);
  const out = [];

  out.push(() => h('div.ss-slide.ss-intro',
    h('h1.ss-title.slam', '📊 The Numbers'),
    h('p.ss-sub', stats.since ? `Since ${new Date(stats.since).toLocaleDateString('en-AU', { day: 'numeric', month: 'long' })}` : 'So far'),
    h('div.ss-tiles', [
      ['games played', stats.games], ['minutes of chaos', stats.minutes], ['answers written', sum('answersWritten')],
      ['votes cast', sum('votesCast')], ['shutouts', sum('shutouts')], ['panic buttons', sum('panics')],
    ].map(([label, n], i) => h('div.ss-tile.pop-in', { style: { animationDelay: `${0.3 + i * 0.15}s` } },
      countUp(h('b'), n), h('span', label))))));

  if (ps.length) {
    out.push(() => h('div.ss-slide', h('h2.ss-head.slide-up', '🏆 Who wins the most'),
      bars(ps.slice(0, 10), { value: (p) => p.wins, label: (p) => `${p.wins} win${p.wins === 1 ? '' : 's'} · ${fmt(p.points)} pts` })));
  }

  const timed = ps.filter((p) => c(p, 'answerTimed') >= 2)
    .map((p) => ({ ...p, avg: per(c(p, 'answerMs'), c(p, 'answerTimed')) })).sort((a, b) => a.avg - b.avg);
  out.push(() => h('div.ss-slide', h('h2.ss-head.slide-up', '⏱️ Average time to reply'),
    timed.length
      ? [h('p.ss-sub', 'Fastest at the top. Speed is not the same as funny.'),
        bars(timed.slice(0, 10), { value: (p) => p.avg, label: (p) => sec(p.avg) })]
      : h('p.ss-empty', 'Reply times start counting from your next game. Type fast. We\'re watching now.')));

  const aw = awards(ps);
  if (aw.length) {
    out.push(() => h('div.ss-slide', h('h2.ss-head.slide-up', '🏅 Awards'),
      h('div.ss-awards', aw.map((a, i) => h('div.ss-award.flip-in', { style: { animationDelay: `${0.3 + i * 0.22}s` } },
        h('div.ss-emoji', a.emoji), h('b', a.title), avatar(a.p, '3.4rem'), h('span.ss-who', a.p.name), h('span.ss-why', a.text))))));
  }

  if (stats.best?.length) {
    out.push(() => h('div.ss-slide', h('h2.ss-head.slide-up', '💬 Greatest hits'),
      h('div.ss-best', stats.best.map((b, i) => h('div.ss-quote.pop-in', { style: { animationDelay: `${0.3 + i * 0.35}s` } },
        h('span.ss-prompt', b.prompt), h('b.ss-answer', b.answer),
        h('span.ss-by', `${b.name} · ${b.votes}/${b.totalVotes} votes`))))));
  }

  out.push(() => h('div.ss-slide.ss-intro', h('h1.ss-title.slam', 'That\'s the numbers.'), h('p.ss-sub', 'Now go and make some new ones.')));
  return out;
}

export async function openStatsShow(code) {
  const root = h('div.ss-root', h('div.ss-loading', 'Crunching the numbers…'));
  document.body.append(root);
  let stats;
  try { stats = await api(`/api/rooms/${code}/stats`); } catch (e) {
    mountInto(root, h('div.ss-slide.ss-intro', h('h2', 'Couldn’t load the stats'), h('p', String(e.message || e))));
    setTimeout(() => root.remove(), 3000);
    return;
  }
  const list = slides(stats);
  let i = -1; let timer = null;
  const stage = h('div.ss-stage');
  const dots = h('div.ss-progress', list.map(() => h('span', h('i'))));
  const close = () => { clearTimeout(timer); removeEventListener('keydown', onKey); root.remove(); };
  const show = (n) => {
    if (n >= list.length) { close(); return; }
    i = Math.max(0, n);
    clearTimeout(timer);
    mountInto(stage, list[i]());
    [...dots.children].forEach((d, k) => { d.className = k < i ? 'done' : k === i ? 'now' : ''; });
    dots.children[i].firstChild.style.animationDuration = `${SLIDE_MS}ms`;
    timer = setTimeout(() => show(i + 1), SLIDE_MS);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === ' ') show(i + 1);
    else if (e.key === 'ArrowLeft') show(i - 1);
  };
  addEventListener('keydown', onKey);
  mountInto(root, stage, dots, h('button.ss-close', { onClick: close, title: 'Close (Esc)' }, '✕'));
  stage.addEventListener('click', () => show(i + 1));
  show(0);
}
