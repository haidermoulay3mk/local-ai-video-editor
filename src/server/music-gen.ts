// Original music, synthesized from scratch on this PC — 100% owned by you, no Content ID claims, no samples.
// Each style has a real arrangement (intro → drop → break → drop → outro) and returns its exact beat grid
// and drop times, so edits can cut on the beat and land the payoff on the drop.
// Honest limit: these are solid, simple beats — for a polished sound, add tracks from free creator libraries.

export const GEN_STYLES = {
  phonk: { label: "Phonk (cowbell + 808)", bpm: 128, genre: "phonk", moods: ["hype", "aggressive", "dark"] },
  lofi: { label: "Lo-fi chill", bpm: 82, genre: "lo-fi", moods: ["chill", "happy"] },
  cinematic: { label: "Cinematic build", bpm: 100, genre: "cinematic", moods: ["epic", "tense", "inspiring"] },
  upbeat: { label: "Upbeat pop/dance", bpm: 122, genre: "pop", moods: ["happy", "hype", "inspiring"] },
} as const;
export type GenStyle = keyof typeof GEN_STYLES;

const SR = 44100;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

class Bus {
  constructor(public buf: Float32Array) {}
  /** Render a voice: fn(localTimeSec) → sample, for `dur` seconds starting at `t0`. */
  add(t0: number, dur: number, fn: (t: number, i: number) => number, gain = 1) {
    const s0 = Math.max(0, Math.round(t0 * SR));
    const n = Math.min(Math.round(dur * SR), this.buf.length - s0);
    for (let i = 0; i < n; i++) this.buf[s0 + i]! += fn(i / SR, i) * gain;
  }
}

// ---------------------------------------------------------------- instruments

function kick(b: Bus, t0: number, gain = 1, hi = 150, lo = 45, decay = 0.32) {
  let ph = 0;
  b.add(t0, decay * 2.2, (t) => {
    const f = lo + (hi - lo) * Math.exp(-t * 28);
    ph += (2 * Math.PI * f) / SR;
    const click = t < 0.004 ? (1 - t / 0.004) * 0.6 : 0;
    return (Math.sin(ph) * Math.exp(-t / decay) + click) * 0.95;
  }, gain);
}

function noiseHit(b: Bus, t0: number, r: () => number, dur: number, decay: number, hp: number, gain: number) {
  let prev = 0;
  let y = 0;
  const a = Math.exp((-2 * Math.PI * hp) / SR);
  b.add(t0, dur, (t) => {
    const x = r() * 2 - 1;
    y = a * (y + x - prev); // one-pole high-pass
    prev = x;
    return y * Math.exp(-t / decay);
  }, gain);
}

function clap(b: Bus, t0: number, r: () => number, gain = 0.55) {
  for (const d of [0, 0.011, 0.022]) noiseHit(b, t0 + d, r, 0.03, 0.008, 900, gain * 0.6);
  noiseHit(b, t0 + 0.03, r, 0.25, 0.07, 1100, gain);
  let ph = 0;
  b.add(t0, 0.08, (t) => {
    ph += (2 * Math.PI * 190) / SR;
    return Math.sin(ph) * Math.exp(-t / 0.025);
  }, gain * 0.35);
}

const hat = (b: Bus, t0: number, r: () => number, open = false, gain = 0.18) =>
  noiseHit(b, t0, r, open ? 0.32 : 0.06, open ? 0.12 : 0.018, 7000, gain);

/** 808-style cowbell: two detuned square waves (ratio ~1.48), band-limited, fast decay — the phonk lead. */
function cowbell(b: Bus, t0: number, freq: number, gain = 0.22, decay = 0.2) {
  let p1 = 0;
  let p2 = 0;
  let lp = 0;
  let hpPrev = 0;
  let hp = 0;
  b.add(t0, decay * 3.5, (t) => {
    p1 = (p1 + freq / SR) % 1;
    p2 = (p2 + (freq * 1.4836) / SR) % 1;
    const sq = (p1 < 0.5 ? 1 : -1) + (p2 < 0.5 ? 1 : -1);
    lp += 0.35 * (sq - lp); // soften the edges
    hp = 0.985 * (hp + lp - hpPrev);
    hpPrev = lp;
    const env = t < 0.002 ? t / 0.002 : Math.exp(-t / decay) * 0.85 + Math.exp(-t / 0.03) * 0.15;
    return hp * env * 0.5;
  }, gain);
}

/** 808 sub: saturated sine with optional glide from the previous note. */
function bass808(b: Bus, t0: number, freq: number, dur: number, gain = 0.6, from?: number) {
  let ph = 0;
  b.add(t0, dur + 0.15, (t) => {
    const glide = from ? from * (freq / from) ** Math.min(1, t / 0.06) : freq;
    const f = glide * (1 + 0.04 * Math.exp(-t * 30));
    ph += (2 * Math.PI * f) / SR;
    const env = Math.min(1, t / 0.005) * (t < dur ? Math.exp(-t / (dur * 1.8)) : Math.exp(-dur / (dur * 1.8)) * Math.exp(-(t - dur) / 0.03));
    return Math.tanh(Math.sin(ph) * 2.2) * env;
  }, gain);
}

/** Karplus-Strong plucked string — warm plucks for pop/cinematic pulses. */
function pluck(b: Bus, t0: number, freq: number, r: () => number, dur = 0.6, gain = 0.25, damp = 0.996) {
  const N = Math.max(2, Math.round(SR / freq));
  const ring = new Float32Array(N);
  for (let i = 0; i < N; i++) ring[i] = r() * 2 - 1;
  let idx = 0;
  b.add(t0, dur, (t) => {
    const a = ring[idx]!;
    const nx = ring[(idx + 1) % N]!;
    ring[idx] = damp * 0.5 * (a + nx);
    idx = (idx + 1) % N;
    return a * (t > dur - 0.05 ? (dur - t) / 0.05 : 1);
  }, gain);
}

/** Soft electric-piano chord (sine + a touch of 2nd harmonic, tremolo) for lo-fi. */
function keys(b: Bus, t0: number, notes: number[], dur: number, gain = 0.09) {
  const phs = notes.map(() => 0);
  b.add(t0, dur + 0.4, (t) => {
    let s = 0;
    notes.forEach((m, k) => {
      const f = midiHz(m) * (1 + (k % 2 ? 0.0015 : -0.0015));
      phs[k]! += (2 * Math.PI * f) / SR;
      s += Math.sin(phs[k]!) + 0.18 * Math.sin(2 * phs[k]!);
    });
    const env = Math.min(1, t / 0.02) * (t < dur ? Math.exp(-t / 2.5) : Math.exp(-dur / 2.5) * Math.exp(-(t - dur) / 0.12));
    return s * env * (0.85 + 0.15 * Math.sin(2 * Math.PI * 4.5 * t));
  }, gain);
}

/** Detuned saw pad through a gentle low-pass — drones and stabs. */
function pad(b: Bus, t0: number, notes: number[], dur: number, gain = 0.05, attack = 0.6, cutoff = 1400) {
  const phs = notes.flatMap(() => [0, 0.33, 0.66]);
  let lp = 0;
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
  b.add(t0, dur + 0.8, (t) => {
    let s = 0;
    notes.forEach((m, k) => {
      for (let d = 0; d < 3; d++) {
        const i = k * 3 + d;
        phs[i] = (phs[i]! + (midiHz(m) * (1 + (d - 1) * 0.004)) / SR) % 1;
        s += phs[i]! * 2 - 1;
      }
    });
    lp += a * (s - lp);
    const env = Math.min(1, t / attack) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.35));
    return lp * env;
  }, gain);
}

function riser(b: Bus, t0: number, dur: number, r: () => number, gain = 0.12) {
  let y = 0;
  let prev = 0;
  b.add(t0, dur, (t) => {
    const k = t / dur;
    const a = Math.exp((-2 * Math.PI * (500 + 7000 * k * k)) / SR);
    const x = r() * 2 - 1;
    y = a * (y + x - prev);
    prev = x;
    return y * k * k;
  }, gain);
}

function impact(b: Bus, t0: number, r: () => number, gain = 0.8) {
  kick(b, t0, gain, 90, 32, 0.9);
  noiseHit(b, t0, r, 1.2, 0.35, 200, gain * 0.25);
}

// ---------------------------------------------------------------- master: reverb, sidechain, limiter

function reverb(x: Float32Array, mix: number): Float32Array {
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ d, buf: new Float32Array(d), i: 0, lp: 0 }));
  const aps = [225, 556].map((d) => ({ d, buf: new Float32Array(d), i: 0 }));
  const out = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i]!;
      c.lp = y * 0.8 + c.lp * 0.2;
      c.buf[c.i] = x[n]! + c.lp * 0.78;
      c.i = (c.i + 1) % c.d;
      s += y;
    }
    s *= 0.25;
    for (const a of aps) {
      const y = a.buf[a.i]!;
      const v = s + y * 0.5;
      a.buf[a.i] = v;
      a.i = (a.i + 1) % a.d;
      s = y - v * 0.5;
    }
    out[n] = x[n]! + s * mix;
  }
  return out;
}

// ---------------------------------------------------------------- arrangement

type Section = { bars: number; kind: "intro" | "drop" | "break" | "outro" };

function arrangement(totalBars: number): Section[] {
  const out: Section[] = [{ bars: 4, kind: "intro" }];
  let used = 4;
  let flip = 0;
  while (used + 4 < totalBars) {
    const kind = flip % 2 === 0 ? "drop" : "break";
    const bars = Math.min(kind === "drop" ? 8 : 4, totalBars - used - 2);
    if (bars <= 0) break;
    out.push({ bars, kind });
    used += bars;
    flip++;
  }
  out.push({ bars: Math.max(2, totalBars - used), kind: "outro" });
  return out;
}

export type GenResult = { samples: Float32Array; beats: number[]; drops: number[]; bpm: number; seconds: number };

export function synthesize(style: GenStyle, opts: { bpm?: number; seconds?: number; seed?: number } = {}): GenResult {
  const r = rng(opts.seed ?? 1);
  const bpm = Math.min(180, Math.max(60, opts.bpm ?? GEN_STYLES[style].bpm));
  const beat = 60 / bpm;
  const bar = beat * 4;
  const step = beat / 4; // 16th note
  const totalBars = Math.max(12, Math.round((opts.seconds ?? 60) / bar));
  const sections = arrangement(totalBars);
  const seconds = totalBars * bar + 2;
  const len = Math.ceil(seconds * SR);
  const drums = new Bus(new Float32Array(len));
  const bass = new Bus(new Float32Array(len));
  const music = new Bus(new Float32Array(len));
  const kicks: number[] = [];
  const drops: number[] = [];

  // Key + harmony (minor for phonk/cinematic, major for lofi/upbeat).
  const root = [40, 41, 42, 43, 44, 45][Math.floor(r() * 6)]!; // E2..A2
  const minorPent = [0, 3, 5, 7, 10];
  const prog = style === "lofi" ? [[2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11], [9, 12, 16, 19]] // ii7 V7 Imaj7 vi7
    : style === "upbeat" ? [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]] // I V vi IV
    : [[0, 3, 7], [8, 12, 15], [10, 14, 17], [7, 10, 14]]; // i VI VII v
  // Phonk lead: a seeded 2-bar cowbell riff on syncopated 16ths.
  const riffSteps = [0, 3, 6, 8, 11, 14, 16, 19, 22, 24, 27, 30];
  const riff = riffSteps.map((s, k) => ({ s, deg: minorPent[Math.floor(r() * 5)]! + (k % 4 === 3 ? 12 : 0) }));

  let t = 0;
  let barIndex = 0;
  for (const sec of sections) {
    if (sec.kind === "drop") drops.push(t);
    for (let bi = 0; bi < sec.bars; bi++, barIndex++) {
      const b0 = t + bi * bar;
      const chord = prog[Math.floor(barIndex / (style === "lofi" ? 1 : 2)) % prog.length]!;
      const full = sec.kind === "drop";
      const lastBarOfSection = bi === sec.bars - 1;

      if (style === "phonk") {
        for (const n of riff) {
          if (n.s >= 16 * (barIndex % 2) && n.s < 16 * (barIndex % 2) + 16) {
            const local = n.s - 16 * (barIndex % 2);
            cowbell(music, b0 + local * step, midiHz(root + 36 + n.deg), sec.kind === "intro" ? 0.13 : 0.2);
          }
        }
        if (full) {
          for (const s of [0, 7, 10]) {
            kick(drums, b0 + s * step, 1);
            kicks.push(b0 + s * step);
          }
          for (const s of [4, 12]) clap(drums, b0 + s * step, r);
          for (let s = 0; s < 16; s += 2) hat(drums, b0 + s * step, r);
          if (lastBarOfSection) for (let s = 12; s < 16; s += 0.5) hat(drums, b0 + s * step, r, false, 0.12); // hat roll
          const notes = [[0, chord[0]!], [7, chord[0]!], [10, chord[1]! - 12]] as const;
          let prev: number | undefined;
          for (const [s, deg] of notes) {
            const f = midiHz(root + deg);
            bass808(bass, b0 + s * step, f, (s === 10 ? 6 : s === 7 ? 3 : 7) * step, 0.55, prev);
            prev = f;
          }
        } else if (sec.kind === "break") {
          bass808(bass, b0, midiHz(root + chord[0]!), bar * 0.9, 0.35);
          for (let s = 0; s < 16; s += 4) hat(drums, b0 + s * step, r, s === 8, 0.1);
        } else {
          for (let s = 0; s < 16; s += 4) hat(drums, b0 + s * step, r, false, 0.08);
        }
      } else if (style === "lofi") {
        keys(music, b0, chord.map((d) => root + 24 + d), bar * 0.95);
        if (sec.kind !== "intro") {
          const swing = step * 0.18;
          for (const s of [0, 10]) {
            kick(drums, b0 + s * step, 0.7, 95, 50, 0.22);
            kicks.push(b0 + s * step);
          }
          for (const s of [4, 12]) noiseHit(drums, b0 + s * step, r, 0.2, 0.06, 1500, 0.32);
          for (let s = 0; s < 16; s += 2) hat(drums, b0 + s * step + (s % 4 === 2 ? swing : 0), r, false, 0.07);
          bass808(bass, b0, midiHz(root + chord[0]! - 12), bar * 0.45, 0.35);
          bass808(bass, b0 + bar * 0.5, midiHz(root + chord[0]! - 12), bar * 0.4, 0.3);
        }
      } else if (style === "cinematic") {
        pad(music, b0, chord.map((d) => root + 12 + d), bar, sec.kind === "intro" ? 0.035 : 0.05, 1.2, 900);
        if (sec.kind !== "intro") {
          const n = sec.kind === "drop" ? 8 : 4;
          for (let k = 0; k < n; k++) pluck(music, b0 + (k * bar) / n, midiHz(root + 36 + chord[k % chord.length]!), r, 0.35, 0.22);
        }
        if (full && bi % 2 === 0) {
          impact(drums, b0, r);
          kicks.push(b0);
        }
        if (full) for (const s of [6, 14]) kick(drums, b0 + s * step, 0.45, 120, 70, 0.25); // toms
        if (sec.kind === "break" && lastBarOfSection) riser(music, b0, bar, r);
      } else {
        // upbeat
        for (const [k, d] of chord.entries()) pluck(music, b0 + k * 0.012, midiHz(root + 36 + d), r, bar * 0.5, 0.12, 0.998);
        for (const [k, d] of chord.entries()) pluck(music, b0 + bar / 2 + k * 0.012, midiHz(root + 36 + d), r, bar * 0.45, 0.1, 0.998);
        if (full) {
          for (let s = 0; s < 16; s += 4) {
            kick(drums, b0 + s * step, 0.95, 140, 50, 0.25);
            kicks.push(b0 + s * step);
            hat(drums, b0 + (s + 2) * step, r, true, 0.12);
          }
          for (const s of [4, 12]) clap(drums, b0 + s * step, r, 0.45);
          for (let s = 2; s < 16; s += 4) bass808(bass, b0 + s * step, midiHz(root + chord[0]!), step * 1.6, 0.4);
        } else if (sec.kind === "break" && lastBarOfSection) {
          riser(music, b0, bar, r);
        }
      }
    }
    t += sec.bars * bar;
  }
  // Outro tail: one last ringing note so the track doesn't just stop.
  if (style === "phonk") bass808(bass, t, midiHz(root), 1.6, 0.4);
  else pad(music, t, prog[0]!.map((d) => root + 12 + d), 1.4, 0.04, 0.05, 900);

  // Sidechain: music + bass dip under each kick (the "pumping" feel).
  const duck = new Float32Array(len).fill(1);
  for (const k of kicks) {
    const s0 = Math.round(k * SR);
    for (let i = 0; i < 0.18 * SR && s0 + i < len; i++) duck[s0 + i] = Math.min(duck[s0 + i]!, 0.45 + 0.55 * (i / (0.18 * SR)));
  }
  const wet = reverb(music.buf, style === "lofi" ? 0.25 : 0.35);
  const out = new Float32Array(len);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const v = drums.buf[i]! + (bass.buf[i]! + wet[i]!) * duck[i]!;
    out[i] = Math.tanh(v * 1.4);
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  const norm = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < len; i++) out[i]! *= norm;
  // Fade the final second out.
  for (let i = 0; i < SR && i < len; i++) out[len - 1 - i]! *= i / SR;

  const beats: number[] = [];
  for (let k = 0; k * beat < totalBars * bar; k++) beats.push(Math.round(k * beat * 1000) / 1000);
  return { samples: out, beats, drops: drops.map((d) => Math.round(d * 1000) / 1000), bpm, seconds };
}

export const GEN_SAMPLE_RATE = SR;
