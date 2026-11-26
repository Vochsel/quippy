// Procedural soundtrack + sound effects, synthesised live with Web Audio — no
// audio files. Each phase of a game has its own little band: a lounge-funk
// lobby, ticking "thinking" music while people write, suspense for voting,
// a bouncy results groove and a fanfare for the winner.

const A4 = 440;
const NOTE = { C: -9, 'C#': -8, Db: -8, D: -7, 'D#': -6, Eb: -6, E: -5, F: -4, 'F#': -3, Gb: -3, G: -2, 'G#': -1, Ab: -1, A: 0, 'A#': 1, Bb: 1, B: 2 };
export function freq(n) {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(n);
  if (!m) return 0;
  return A4 * 2 ** ((NOTE[m[1]] + (Number(m[2]) - 4) * 12) / 12);
}
const chord = (...notes) => notes.map(freq);

// Patterns are 16 steps per bar. x = hit, o = accent/open, . = rest.
const SONGS = {
  lobby: {
    bpm: 96, swing: 0.16, master: 0.9,
    chords: [chord('D3', 'F3', 'A3', 'C4', 'E4'), chord('G2', 'B3', 'E4', 'F4'), chord('C3', 'E3', 'G3', 'B3', 'D4'), chord('A2', 'C#4', 'G3', 'Bb3')],
    roots: ['D2', 'G2', 'C2', 'A2'],
    kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xo',
    bass: 'x..x..x...x.x...', bassWalk: [0, 0, 7, 12, 10, 7, 0, 3],
    keys: '..x...x.....x.x.', pad: true, arp: null, lead: 'lounge',
  },
  intro: {
    bpm: 112, swing: 0.08, master: 1,
    chords: [chord('C3', 'E3', 'G3', 'C4'), chord('F3', 'A3', 'C4', 'F4'), chord('A2', 'C3', 'E3', 'A3'), chord('G2', 'B2', 'D3', 'G3')],
    roots: ['C2', 'F2', 'A1', 'G1'],
    kick: 'x...x...x...x...', snare: '....x.......x..x', hat: '..x...x...x...x.',
    bass: 'x.x...x.x.x...x.', bassWalk: [0, 12, 0, 7],
    keys: 'x..x..x.....x...', pad: false, arp: '.x.x.x.x.x.x.x.x', lead: null,
  },
  writing: {
    bpm: 124, swing: 0.05, master: 0.8,
    chords: [chord('A2', 'C3', 'E3', 'G3'), chord('F2', 'A2', 'C3', 'E3'), chord('C3', 'E3', 'G3', 'B3'), chord('G2', 'B2', 'D3', 'F#3')],
    roots: ['A1', 'F1', 'C2', 'G1'],
    kick: 'x...x...x...x...', snare: '........x.......', hat: 'xxxxxxxxxxxxxxxx',
    bass: 'x.xx.xx.x.xx.xx.', bassWalk: [0, 0, 12, 0, 7, 0, 12, 7],
    keys: null, pad: true, arp: 'x.x.x.x.x.x.x.x.', lead: null, tick: true,
  },
  voting: {
    bpm: 104, swing: 0, master: 0.8,
    chords: [chord('C3', 'Eb3', 'G3'), chord('Ab2', 'C3', 'Eb3'), chord('F2', 'Ab2', 'C3'), chord('G2', 'B2', 'D3')],
    roots: ['C2', 'Ab1', 'F1', 'G1'],
    kick: 'x.......x.......', snare: null, hat: '..x...x...x...x.',
    bass: 'x...x...x...x...', bassWalk: [0, 0, 0, 0],
    keys: null, pad: true, arp: 'x..x..x..x..x.x.', lead: null,
  },
  results: {
    bpm: 116, swing: 0.12, master: 0.9,
    chords: [chord('Bb2', 'D3', 'F3', 'A3'), chord('Eb3', 'G3', 'Bb3', 'D4'), chord('C3', 'Eb3', 'G3', 'Bb3'), chord('F2', 'A2', 'C3', 'Eb3')],
    roots: ['Bb1', 'Eb2', 'C2', 'F1'],
    kick: 'x..x..x...x..x..', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xo',
    bass: 'x..x..x.x.x..x..', bassWalk: [0, 12, 7, 10, 0, 12, 7, 5],
    keys: '.x...x...x...x..', pad: false, arp: null, lead: null,
  },
  final: {
    bpm: 132, swing: 0, master: 0.9,
    chords: [chord('E3', 'G3', 'B3'), chord('C3', 'E3', 'G3'), chord('G2', 'B2', 'D3'), chord('D3', 'F#3', 'A3')],
    roots: ['E1', 'C2', 'G1', 'D2'],
    kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..o...o...o...o.',
    bass: 'xxxxxxxxxxxxxxxx', bassWalk: [0, 12],
    keys: null, pad: true, arp: 'x.xxx.xxx.xxx.xx', lead: null, tick: true,
  },
  victory: {
    bpm: 120, swing: 0.1, master: 1,
    chords: [chord('C3', 'E3', 'G3', 'C4'), chord('G2', 'B2', 'D3', 'G3'), chord('A2', 'C3', 'E3', 'A3'), chord('F2', 'A2', 'C3', 'F3')],
    roots: ['C2', 'G1', 'A1', 'F1'],
    kick: 'x...x...x...x...', snare: '....x.......x.x.', hat: 'x.x.x.x.x.x.x.x.',
    bass: 'x.x.x.x.x.x.x.x.', bassWalk: [0, 12],
    keys: 'x...x...x...x...', pad: false, arp: 'xxxxxxxxxxxxxxxx', lead: null,
  },
};

const LOUNGE_LEAD = [
  // [step, semitones from chord root (octave 5), length in steps] per bar
  [[2, 12, 2], [4, 15, 2], [7, 19, 3], [12, 17, 2], [14, 15, 2]],
  [[0, 16, 3], [6, 14, 2], [10, 12, 4]],
  [[2, 11, 2], [4, 12, 2], [6, 16, 2], [8, 19, 4], [13, 21, 2]],
  [[0, 19, 2], [4, 16, 2], [8, 13, 4], [14, 12, 2]],
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.current = null;
    this.trackName = null;
    this.musicLevel = Number(localStorage.getItem('quippy.music') ?? 0.55);
    this.sfxLevel = Number(localStorage.getItem('quippy.sfx') ?? 0.8);
    this.ducked = false;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(this.ctx.destination);
    this.out = comp;
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = this.musicLevel;
    this.musicBus.connect(comp);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.sfxLevel;
    this.sfxBus.connect(comp);
    // Shared reverb-ish echo for a bit of room.
    this.echo = this.ctx.createDelay(1);
    this.echo.delayTime.value = 0.28;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.25;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.18;
    this.echo.connect(fb).connect(this.echo);
    this.echo.connect(wet).connect(this.musicBus);
    this.noise = this.#noiseBuffer();
    if (this.pendingTrack) this.music(this.pendingTrack);
  }

  #noiseBuffer() {
    const len = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setMusicLevel(v) {
    this.musicLevel = v;
    localStorage.setItem('quippy.music', v);
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(this.ducked ? v * 0.3 : v, this.ctx.currentTime, 0.1);
  }

  setSfxLevel(v) {
    this.sfxLevel = v;
    localStorage.setItem('quippy.sfx', v);
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  duck(on) {
    this.ducked = on;
    if (!this.musicBus) return;
    this.musicBus.gain.setTargetAtTime(on ? this.musicLevel * 0.3 : this.musicLevel, this.ctx.currentTime, on ? 0.08 : 0.4);
  }

  music(name) {
    if (!this.ctx) { this.pendingTrack = name; return; }
    if (name === this.trackName) return;
    this.trackName = name;
    this.current?.stop();
    this.current = null;
    const song = SONGS[name];
    if (song) {
      this.current = new Band(this, song, name);
      this.current.start();
    }
  }

  // ---------------------------------------------------------------- sfx
  sfx(name) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.01;
    const s = SFX[name];
    if (s) s(this, t);
  }

  tone(t, f, dur, { type = 'sine', gain = 0.3, bus = this.sfxBus, attack = 0.005, slideTo = null, filter = null } = {}) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o.connect(g);
    if (filter) {
      const f2 = this.ctx.createBiquadFilter();
      f2.type = 'lowpass';
      f2.frequency.value = filter;
      node = node.connect(f2);
    }
    node.connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  noiseHit(t, dur, { gain = 0.3, type = 'highpass', freqFrom = 6000, freqTo = null, q = 0.7, bus = this.sfxBus } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freqFrom, t);
    if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }
}

const SFX = {
  join: (a, t) => { a.tone(t, 660, 0.12, { type: 'triangle', gain: 0.35 }); a.tone(t + 0.09, 990, 0.18, { type: 'triangle', gain: 0.35 }); },
  select: (a, t) => a.tone(t, 880, 0.1, { type: 'square', gain: 0.12, filter: 2500 }),
  submit: (a, t) => a.tone(t, 380, 0.16, { type: 'sine', gain: 0.5, slideTo: 1100 }),
  vote: (a, t) => { a.tone(t, 740, 0.08, { type: 'square', gain: 0.1, filter: 3000 }); a.tone(t + 0.06, 1110, 0.1, { type: 'square', gain: 0.1, filter: 3000 }); },
  whoosh: (a, t) => a.noiseHit(t, 0.55, { type: 'bandpass', freqFrom: 300, freqTo: 5000, q: 2, gain: 0.5 }),
  reveal: (a, t) => {
    a.noiseHit(t, 0.4, { type: 'bandpass', freqFrom: 4000, freqTo: 400, q: 1.5, gain: 0.4 });
    [523, 659, 784].forEach((f) => a.tone(t + 0.15, f, 0.5, { type: 'sawtooth', gain: 0.08, filter: 2200 }));
  },
  shutout: (a, t) => {
    a.noiseHit(t, 1.2, { type: 'highpass', freqFrom: 5000, gain: 0.35 });
    a.tone(t, 110, 0.5, { type: 'sine', gain: 0.8, slideTo: 40 });
    [523, 659, 784, 1046].forEach((f, i) => a.tone(t + 0.05 + i * 0.07, f, 0.9, { type: 'sawtooth', gain: 0.1, filter: 3000 }));
  },
  // The big one: drum roll -> airhorn chord -> crash -> sparkle.
  shutoutBig: (a, t) => {
    for (let i = 0; i < 10; i++) a.noiseHit(t + i * 0.045, 0.06, { type: 'bandpass', freqFrom: 1800, q: 1, gain: 0.12 + i * 0.02 });
    const hit = t + 0.48;
    a.tone(hit, 90, 0.7, { type: 'sine', gain: 0.9, slideTo: 38 });
    a.noiseHit(hit, 1.6, { type: 'highpass', freqFrom: 4500, gain: 0.4 });
    [261.6, 329.6, 392, 523.2].forEach((f) => {
      a.tone(hit, f, 1.1, { type: 'sawtooth', gain: 0.1, filter: 2800, attack: 0.02 });
      a.tone(hit, f * 1.006, 1.1, { type: 'square', gain: 0.05, filter: 2200, attack: 0.02 });
    });
    [1046, 1318, 1568, 2093, 2637].forEach((f, i) => a.tone(hit + 0.25 + i * 0.07, f, 0.25, { type: 'triangle', gain: 0.12 }));
  },
  buzzer: (a, t) => { a.tone(t, 150, 0.45, { type: 'square', gain: 0.18, filter: 900 }); a.tone(t, 155, 0.45, { type: 'sawtooth', gain: 0.1, filter: 900 }); },
  tick: (a, t) => a.tone(t, 1800, 0.03, { type: 'square', gain: 0.08, filter: 4000 }),
  fanfare: (a, t) => {
    const notes = [523, 659, 784, 1046, 784, 1046];
    notes.forEach((f, i) => a.tone(t + i * 0.12, f, i === notes.length - 1 ? 1.2 : 0.2, { type: 'sawtooth', gain: 0.12, filter: 3500 }));
    a.noiseHit(t + 0.6, 1.5, { type: 'highpass', freqFrom: 6000, gain: 0.2 });
  },
};

// A little procedural band playing one song on a loop.
class Band {
  constructor(engine, song, name) {
    this.a = engine;
    this.song = song;
    this.name = name;
    this.ctx = engine.ctx;
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 0.0001;
    this.bus.connect(engine.musicBus);
    this.bus.connect(engine.echo);
  }

  start() {
    const t = this.ctx.currentTime;
    this.bus.gain.exponentialRampToValueAtTime(this.song.master * 0.5, t + 0.8);
    this.step = 0;
    this.next = t + 0.06;
    this.timer = setInterval(() => this.#schedule(), 25);
  }

  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    this.bus.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    setTimeout(() => this.bus.disconnect(), 900);
  }

  #schedule() {
    const sixteenth = 60 / this.song.bpm / 4;
    while (this.next < this.ctx.currentTime + 0.15) {
      const swing = this.step % 2 ? sixteenth * this.song.swing : 0;
      this.#play(this.step, this.next + swing, sixteenth);
      this.next += sixteenth;
      this.step = (this.step + 1) % (16 * this.song.chords.length);
    }
  }

  #hit(pattern, i) {
    return pattern ? pattern[i % 16] : '.';
  }

  #play(step, t, sx) {
    const s = this.song;
    const bar = Math.floor(step / 16);
    const i = step % 16;
    const ch = s.chords[bar];
    const root = freq(s.roots[bar]);

    if (this.#hit(s.kick, i) !== '.') this.#kick(t);
    if (this.#hit(s.snare, i) !== '.') this.#snare(t);
    const hat = this.#hit(s.hat, i);
    if (hat !== '.') this.#hat(t, hat === 'o');
    if (s.tick && i % 4 === 0) this.a.tone(t, 2400, 0.02, { type: 'square', gain: 0.025, bus: this.bus, filter: 5000 });

    if (this.#hit(s.bass, i) !== '.') {
      const walk = s.bassWalk[Math.floor(i / 2) % s.bassWalk.length];
      this.#bass(t, root * 2 ** (walk / 12), sx * 1.8);
    }
    if (s.pad && i === 0) this.#pad(t, ch, sx * 16);
    if (this.#hit(s.keys, i) !== '.') this.#keys(t, ch, sx * 2.5);
    if (s.arp && this.#hit(s.arp, i) !== '.') {
      const f = ch[i % ch.length] * (i % 8 < 4 ? 2 : 4);
      this.a.tone(t, f, sx * 1.4, { type: 'square', gain: 0.035, bus: this.bus, filter: 2600 });
    }
    if (s.lead === 'lounge') {
      for (const [st, semi, len] of LOUNGE_LEAD[bar % LOUNGE_LEAD.length]) {
        if (st === i) this.a.tone(t, root * 4 * 2 ** ((semi - 12) / 12), sx * len, { type: 'triangle', gain: 0.07, bus: this.bus, attack: 0.02 });
      }
    }
  }

  #kick(t) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.35);
  }

  #snare(t) {
    this.a.noiseHit(t, 0.16, { type: 'highpass', freqFrom: 1400, gain: 0.35, bus: this.bus });
    this.a.tone(t, 190, 0.1, { type: 'triangle', gain: 0.25, bus: this.bus });
  }

  #hat(t, open) {
    this.a.noiseHit(t, open ? 0.22 : 0.045, { type: 'highpass', freqFrom: 7500, gain: open ? 0.12 : 0.09, bus: this.bus });
  }

  #bass(t, f, dur) {
    const o = this.ctx.createOscillator();
    const f2 = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = f;
    f2.type = 'lowpass';
    f2.Q.value = 6;
    f2.frequency.setValueAtTime(900, t);
    f2.frequency.exponentialRampToValueAtTime(180, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f2).connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Electric-piano-ish: FM sine with a decaying modulation index.
  #keys(t, notes, dur) {
    for (const f of notes) {
      const car = this.ctx.createOscillator();
      const mod = this.ctx.createOscillator();
      const modGain = this.ctx.createGain();
      const g = this.ctx.createGain();
      car.frequency.value = f * 2;
      mod.frequency.value = f * 2;
      modGain.gain.setValueAtTime(f * 3, t);
      modGain.gain.exponentialRampToValueAtTime(1, t + dur);
      mod.connect(modGain).connect(car.frequency);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.045, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      car.connect(g).connect(this.bus);
      car.start(t); mod.start(t);
      car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
    }
  }

  #pad(t, notes, dur) {
    for (const f of notes) {
      for (const detune of [-7, 7]) {
        const o = this.ctx.createOscillator();
        const flt = this.ctx.createBiquadFilter();
        const g = this.ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.value = f * 2;
        o.detune.value = detune;
        flt.type = 'lowpass';
        flt.frequency.value = 1100;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.018, t + dur * 0.25);
        g.gain.setValueAtTime(0.018, t + dur * 0.7);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(flt).connect(g).connect(this.bus);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    }
  }
}
