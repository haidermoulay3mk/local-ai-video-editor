// Original sound effects, synthesized from scratch (noise, sweeps, envelopes) — no samples,
// so they are 100% copyright-free. Generated once into assets/sfx.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SFX_NAMES } from "../shared/spec";
import { ROOT } from "./config";

export const SFX_DIR = path.join(ROOT, "assets", "sfx");
const SR = 44100;

function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const gain = peak > 0 ? 0.89 / peak : 1; // normalise to about -1 dBFS
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]! * gain)) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// deterministic noise so regenerated files are identical
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

const buf = (sec: number) => new Float32Array(Math.round(sec * SR));

/** Noise through a swept one-pole low-pass, shaped by an envelope. */
function sweptNoise(sec: number, cutoff: (t: number) => number, env: (t: number) => number, seed: number) {
  const out = buf(sec);
  const n = rng(seed);
  let lp = 0, hp = 0, prev = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / out.length;
    const a = 1 - Math.exp((-2 * Math.PI * cutoff(t)) / SR);
    lp += a * (n() - lp);
    hp = 0.97 * (hp + lp - prev); // remove rumble
    prev = lp;
    out[i] = hp * env(t);
  }
  return out;
}

const GEN: Record<(typeof SFX_NAMES)[number], () => Float32Array> = {
  whoosh: () => sweptNoise(0.7, (t) => 300 + 5200 * Math.sin(Math.PI * t), (t) => Math.sin(Math.PI * Math.pow(t, 0.7)) ** 2, 1),
  swoosh: () => sweptNoise(0.38, (t) => 6000 - 5200 * t, (t) => Math.pow(1 - t, 1.5) * Math.min(1, t * 20), 2),
  pop: () => {
    const out = buf(0.16);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      ph += (2 * Math.PI * (160 + 650 * Math.exp(-t * 45))) / SR;
      out[i] = Math.sin(ph) * Math.exp(-t * 32) * Math.min(1, t * 2000);
    }
    return out;
  },
  click: () => {
    const out = buf(0.05);
    const n = rng(3);
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      out[i] = (n() * Math.exp(-t * 900) + 0.6 * Math.sin(2 * Math.PI * 2300 * t) * Math.exp(-t * 160)) * Math.min(1, t * 8000);
    }
    return out;
  },
  ding: () => {
    const out = buf(1.4);
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      out[i] = (Math.sin(2 * Math.PI * 1320 * t) + 0.45 * Math.sin(2 * Math.PI * 2640 * t) * Math.exp(-t * 2) + 0.25 * Math.sin(2 * Math.PI * 3960 * t) * Math.exp(-t * 4)) *
        Math.exp(-t * 3.2) * Math.min(1, t * 1500);
    }
    return out;
  },
  riser: () => {
    const sec = 2;
    const noise = sweptNoise(sec, (t) => 400 + 7000 * t * t, (t) => t * t, 4);
    let ph = 0;
    for (let i = 0; i < noise.length; i++) {
      const t = i / noise.length;
      ph += (2 * Math.PI * (180 + 900 * t * t)) / SR;
      noise[i] = noise[i]! * 0.8 + 0.35 * Math.sin(ph) * t * t;
    }
    return noise;
  },
  boom: () => {
    const out = buf(1.3);
    const n = rng(5);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      ph += (2 * Math.PI * (38 + 70 * Math.exp(-t * 18))) / SR;
      const body = Math.tanh(1.8 * Math.sin(ph)) * Math.exp(-t * 3.2);
      const thump = n() * Math.exp(-t * 60) * 0.8;
      out[i] = (body + thump) * Math.min(1, t * 3000);
    }
    return out;
  },
  typing: () => {
    const out = buf(1.6);
    const n = rng(6);
    let t = 0.02;
    while (t < 1.55) {
      const start = Math.round(t * SR);
      const pitch = 1800 + 1400 * (n() + 0.5);
      for (let k = 0; k < SR * 0.03 && start + k < out.length; k++) {
        const tt = k / SR;
        out[start + k] = out[start + k]! + (n() * Math.exp(-tt * 700) + 0.4 * Math.sin(2 * Math.PI * pitch * tt) * Math.exp(-tt * 300));
      }
      t += 0.055 + 0.07 * (n() + 0.5);
    }
    return out;
  },
};

/** Writes any missing effects. Returns the names that were generated. */
export function ensureSfx(): string[] {
  mkdirSync(SFX_DIR, { recursive: true });
  const made: string[] = [];
  for (const name of SFX_NAMES) {
    const file = path.join(SFX_DIR, `${name}.wav`);
    if (existsSync(file)) continue;
    writeFileSync(file, wav(GEN[name]()));
    made.push(name);
  }
  return made;
}
