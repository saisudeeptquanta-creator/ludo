/**
 * Sound, synthesised with the Web Audio API.
 *
 * Every effect is generated from oscillators and noise buffers at runtime, so
 * the app ships no audio files: nothing to 404, nothing to preload, and the
 * sounds stay in tune with each other because they share one scale.
 *
 * Browsers block audio until a user gesture; `unlock()` is wired to the first
 * pointer/key event and everything before that is a silent no-op.
 */

const STORAGE_KEY = 'ludo.audio';

const defaults = {
  soundEnabled: true,
  musicEnabled: false,
  effectsVolume: 0.6,
  musicVolume: 0.25,
};

function loadPrefs() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
  } catch {
    return { ...defaults };
  }
}

let prefs = loadPrefs();
let ctx = null;
let effectsGain = null;
let musicGain = null;
let musicTimer = null;
let unlocked = false;
const listeners = new Set();

function ensureContext() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();

  effectsGain = ctx.createGain();
  effectsGain.gain.value = prefs.effectsVolume;
  effectsGain.connect(ctx.destination);

  musicGain = ctx.createGain();
  musicGain.gain.value = prefs.musicVolume * 0.35;
  musicGain.connect(ctx.destination);
  return ctx;
}

export function unlock() {
  if (unlocked) return;
  const c = ensureContext();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  unlocked = true;
  if (prefs.musicEnabled) startMusic();
}

export function getAudioPrefs() {
  return { ...prefs };
}

export function setAudioPrefs(patch) {
  prefs = { ...prefs, ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));

  if (effectsGain) effectsGain.gain.value = prefs.effectsVolume;
  if (musicGain) musicGain.gain.value = prefs.musicVolume * 0.35;
  if (prefs.musicEnabled && unlocked) startMusic();
  else stopMusic();

  for (const fn of listeners) fn(getAudioPrefs());
  return getAudioPrefs();
}

export function onAudioPrefs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ------------------------------------------------------------- primitives --

/** A single shaped tone. */
function tone({ freq, duration = 0.15, type = 'sine', gain = 0.3, at = 0, sweepTo = null }) {
  const c = ensureContext();
  if (!c || !prefs.soundEnabled) return;
  const t0 = c.currentTime + at;

  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t0 + duration);

  const env = c.createGain();
  // Short attack, exponential decay — reads as "percussive" rather than "beep".
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(env);
  env.connect(effectsGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/** Filtered noise burst — used for dice rattle and impacts. */
function noise({ duration = 0.2, gain = 0.2, at = 0, filterFreq = 1800, q = 1 }) {
  const c = ensureContext();
  if (!c || !prefs.soundEnabled) return;
  const t0 = c.currentTime + at;

  const frames = Math.floor(c.sampleRate * duration);
  const buffer = c.createBuffer(1, frames, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;

  const src = c.createBufferSource();
  src.buffer = buffer;

  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterFreq;
  filter.Q.value = q;

  const env = c.createGain();
  env.gain.setValueAtTime(gain, t0);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  src.connect(filter);
  filter.connect(env);
  env.connect(effectsGain);
  src.start(t0);
  src.stop(t0 + duration);
}

// ----------------------------------------------------------------- sounds --

const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0]; // C D E G A

export const sfx = {
  tap: () => tone({ freq: 660, duration: 0.045, type: 'triangle', gain: 0.14 }),

  click: () => tone({ freq: 620, duration: 0.05, type: 'triangle', gain: 0.16 }),

  hover: () => tone({ freq: 900, duration: 0.03, type: 'sine', gain: 0.06 }),

  /** Tumbling rattle, then a settling knock. */
  diceRoll: () => {
    for (let i = 0; i < 7; i += 1) {
      noise({ duration: 0.05, gain: 0.14, at: i * 0.055, filterFreq: 900 + Math.random() * 2200, q: 3 });
    }
    noise({ duration: 0.12, gain: 0.22, at: 0.42, filterFreq: 420, q: 1.5 });
  },

  diceResult: (value = 1) => {
    tone({ freq: PENTATONIC[(value - 1) % 5], duration: 0.18, type: 'triangle', gain: 0.24 });
  },

  /** One short blip per square travelled. */
  tokenStep: (index = 0) => {
    tone({
      freq: 480 + index * 26,
      duration: 0.06,
      type: 'square',
      gain: 0.1,
    });
  },

  tokenSelect: () => tone({ freq: 740, duration: 0.09, type: 'sine', gain: 0.18 }),

  /** Descending thud plus noise — the "sent home" sound. */
  capture: () => {
    tone({ freq: 320, sweepTo: 90, duration: 0.34, type: 'sawtooth', gain: 0.3 });
    noise({ duration: 0.26, gain: 0.24, filterFreq: 500, q: 0.8 });
    tone({ freq: 180, sweepTo: 70, duration: 0.4, type: 'sine', gain: 0.2, at: 0.04 });
  },

  captured: () => {
    tone({ freq: 260, sweepTo: 110, duration: 0.4, type: 'triangle', gain: 0.24 });
  },

  tokenHome: () => {
    [0, 2, 4].forEach((n, i) => {
      tone({ freq: PENTATONIC[n], duration: 0.22, type: 'sine', gain: 0.22, at: i * 0.07 });
    });
  },

  extraTurn: () => {
    tone({ freq: 660, duration: 0.1, type: 'triangle', gain: 0.2 });
    tone({ freq: 990, duration: 0.16, type: 'triangle', gain: 0.18, at: 0.09 });
  },

  yourTurn: () => {
    tone({ freq: 587.33, duration: 0.14, type: 'sine', gain: 0.22 });
    tone({ freq: 880, duration: 0.2, type: 'sine', gain: 0.2, at: 0.12 });
  },

  countdown: () => tone({ freq: 440, duration: 0.13, type: 'triangle', gain: 0.24 }),

  go: () => {
    tone({ freq: 880, duration: 0.3, type: 'triangle', gain: 0.3 });
    tone({ freq: 1320, duration: 0.36, type: 'sine', gain: 0.2, at: 0.05 });
  },

  /** Rising fanfare on the pentatonic scale. */
  win: () => {
    [0, 2, 3, 4, 4].forEach((n, i) => {
      tone({ freq: PENTATONIC[n] * (i === 4 ? 2 : 1), duration: 0.42, type: 'triangle', gain: 0.26, at: i * 0.13 });
    });
  },

  lose: () => {
    [4, 2, 1, 0].forEach((n, i) => {
      tone({ freq: PENTATONIC[n] * 0.5, duration: 0.36, type: 'sine', gain: 0.2, at: i * 0.14 });
    });
  },

  playerJoin: () => {
    tone({ freq: 523.25, duration: 0.12, type: 'sine', gain: 0.18 });
    tone({ freq: 783.99, duration: 0.16, type: 'sine', gain: 0.16, at: 0.1 });
  },

  playerLeave: () => {
    tone({ freq: 500, sweepTo: 260, duration: 0.28, type: 'sine', gain: 0.16 });
  },

  notify: () => {
    tone({ freq: 880, duration: 0.1, type: 'sine', gain: 0.18 });
    tone({ freq: 1174.66, duration: 0.14, type: 'sine', gain: 0.14, at: 0.08 });
  },

  error: () => {
    tone({ freq: 220, duration: 0.16, type: 'square', gain: 0.16 });
    tone({ freq: 180, duration: 0.2, type: 'square', gain: 0.14, at: 0.1 });
  },

  levelUp: () => {
    PENTATONIC.forEach((f, i) => {
      tone({ freq: f, duration: 0.3, type: 'triangle', gain: 0.2, at: i * 0.08 });
    });
  },
};

// ------------------------------------------------------------------ music --

/**
 * Ambient bed: a slow arpeggio over a pad. Deliberately sparse so it can sit
 * under a game for a long time without becoming irritating.
 */
function startMusic() {
  const c = ensureContext();
  if (!c || musicTimer || !prefs.musicEnabled) return;

  const chords = [
    [261.63, 329.63, 392.0],
    [220.0, 277.18, 329.63],
    [246.94, 311.13, 369.99],
    [196.0, 246.94, 293.66],
  ];
  let step = 0;

  const playChord = () => {
    if (!prefs.musicEnabled) return;
    const chord = chords[step % chords.length];
    step += 1;
    chord.forEach((freq, i) => {
      const t0 = c.currentTime + i * 0.5;
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const env = c.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(0.16, t0 + 0.8);
      env.gain.linearRampToValueAtTime(0.0001, t0 + 3.2);
      osc.connect(env);
      env.connect(musicGain);
      osc.start(t0);
      osc.stop(t0 + 3.4);
    });
  };

  playChord();
  musicTimer = setInterval(playChord, 4200);
}

function stopMusic() {
  if (musicTimer) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
}

// Unlock on the first genuine user gesture.
if (typeof window !== 'undefined') {
  const kick = () => {
    unlock();
    window.removeEventListener('pointerdown', kick);
    window.removeEventListener('keydown', kick);
  };
  window.addEventListener('pointerdown', kick, { once: false });
  window.addEventListener('keydown', kick, { once: false });
}
