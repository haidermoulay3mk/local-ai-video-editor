// Music library: tracks you're allowed to use (free creator libraries, your own music, or originals made here),
// analysed for tempo, beat grid, energy and drops so Claude can pick by mood and cut on the beat.
// "Guide only" tracks (e.g. a trending song you'll add later with the platform's own music picker) are heard in
// the preview to time the edit but are NEVER written into an exported video.
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, ffmpegPath } from "./config";
import { GEN_SAMPLE_RATE, GEN_STYLES, type GenStyle, synthesize } from "./music-gen";
import { type MediaRecord, mediaDir, newId, now, type Project, saveProject } from "./store";

export const MUSIC_DIR = path.join(DATA_DIR, "music");
const LIB_FILE = path.join(MUSIC_DIR, "library.json");
export const MUSIC_FILES = path.join(MUSIC_DIR, "files");
export const MUSIC_TMP = path.join(MUSIC_DIR, "tmp");

export const LICENSES = {
  original: "Original — made by this app",
  own: "My own music",
  "youtube-audio-library": "YouTube Audio Library",
  pixabay: "Pixabay Music",
  ncs: "NCS (NoCopyrightSounds)",
  streambeats: "StreamBeats",
  "fma-cc": "Free Music Archive (Creative Commons)",
  "other-licensed": "Other — I have a licence",
  "guide-only": "Guide only — never exported (add it in the app later)",
} as const;
export type MusicLicense = keyof typeof LICENSES;
export const GENRES = [
  "phonk", "hip-hop", "trap", "lo-fi", "pop", "edm", "house", "cinematic", "orchestral", "acoustic", "rock", "ambient", "funk", "arabic", "other",
] as const;
export const MOODS = [
  "hype", "aggressive", "dark", "mysterious", "emotional", "sad", "inspiring", "epic", "chill", "happy", "funny", "romantic", "tense",
] as const;

export type Track = {
  id: string;
  title: string;
  artist?: string;
  file: string; // inside MUSIC_FILES
  duration: number;
  bpm: number | null;
  beats: number[]; // seconds
  energy: number[]; // loudness every 0.5 s, 0..1
  drops: number[]; // seconds where the track "hits" (energy jump) — land the payoff here
  genre: string;
  moods: string[];
  license: MusicLicense;
  attribution?: string; // credit line some free libraries require (goes in the video description)
  guideOnly: boolean;
  addedAt: string;
  source?: string;
};

let cache: Track[] | null = null;

export function listTracks(): Track[] {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(LIB_FILE, "utf8")) as Track[];
    } catch {
      cache = [];
    }
  }
  return cache;
}

function saveLibrary() {
  mkdirSync(MUSIC_DIR, { recursive: true });
  writeFileSync(`${LIB_FILE}.tmp`, JSON.stringify(listTracks(), null, 1));
  renameSync(`${LIB_FILE}.tmp`, LIB_FILE);
}

export const getTrack = (id: string) => listTracks().find((t) => t.id === id) ?? null;
export const trackPath = (t: Track) => path.join(MUSIC_FILES, t.file);

// ---------------------------------------------------------------- analysis (tempo, beats, energy, drops)

async function decodeMono(file: string, rate: number): Promise<Float32Array> {
  const proc = Bun.spawn([ffmpegPath(), "-v", "error", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { stdout: "pipe", stderr: "pipe" });
  const buf = await new Response(proc.stdout).arrayBuffer();
  if ((await proc.exited) !== 0 || buf.byteLength < 4) throw new Error("couldn't read that audio file");
  return new Float32Array(buf);
}

export type Analysis = { duration: number; bpm: number | null; beats: number[]; energy: number[]; drops: number[] };

/** Pure analysis of mono samples (any rate): onset envelope → tempo + beat phase by comb search → energy → drops. */
export function analyzeSamples(x: Float32Array, rate: number): Analysis {
  const duration = x.length / rate;
  const hop = Math.max(1, Math.round((rate * 256) / 11025));
  const fps = rate / hop;
  const n = Math.floor(x.length / hop);
  // Onset envelope from two bands (kick/bass and hats/snare) + broadband, as log-energy flux.
  const aLow = 1 - Math.exp((-2 * Math.PI * 150) / rate);
  const aHigh = Math.exp((-2 * Math.PI * 2000) / rate);
  let lp = 0;
  let hp = 0;
  let prev = 0;
  const eL = new Float32Array(n);
  const eH = new Float32Array(n);
  const eA = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sl = 0;
    let sh = 0;
    let sa = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const v = x[i]!;
      lp += aLow * (v - lp);
      hp = aHigh * (hp + v - prev);
      prev = v;
      sl += lp * lp;
      sh += hp * hp;
      sa += v * v;
    }
    eL[f] = Math.log1p((1000 * sl) / hop);
    eH[f] = Math.log1p((1000 * sh) / hop);
    eA[f] = Math.log1p((1000 * sa) / hop);
  }
  // Each band's flux is scaled to its own average, so snares/claps/hats count as much as booming kicks/808s
  // (otherwise syncopated bass patterns drag the tempo estimate off the real grid).
  const flux = (e: Float32Array) => {
    const d = new Float32Array(n);
    let sum = 0;
    for (let f = 1; f < n; f++) {
      d[f] = Math.max(0, e[f]! - e[f - 1]!);
      sum += d[f]!;
    }
    const avg = sum / Math.max(1, n - 1) || 1;
    for (let f = 0; f < n; f++) d[f]! /= avg;
    return d;
  };
  const fL = flux(eL);
  const fH = flux(eH);
  const fA = flux(eA);
  const onset = new Float32Array(n);
  for (let f = 1; f < n; f++) onset[f] = fL[f]! + fH[f]! + 0.5 * fA[f]!;
  // Remove the slow trend so loud sections don't dominate. The window spans several beats: a ~1-beat
  // window would erase steady hats/claps (the true pulse) while keeping sparse syncopated kicks.
  const win = Math.round(fps * 2);
  const o = new Float32Array(n);
  let acc = 0;
  for (let f = 0; f < n; f++) {
    acc += onset[f]!;
    if (f >= win) acc -= onset[f - win]!;
    o[f] = Math.max(0, onset[f]! - 0.6 * (acc / Math.min(f + 1, win)));
  }
  const o3 = new Float32Array(n);
  for (let f = 0; f < n; f++) o3[f] = Math.max(o[f - 1] ?? 0, o[f]!, o[f + 1] ?? 0);

  let bpm: number | null = null;
  let phase = 0;
  if (n > fps * 6) {
    const prior = (b: number) => Math.exp(-0.5 * (Math.log2(b / 120) / 1) ** 2);
    const comb = (P: number) => {
      let best = 0;
      let bestPhi = 0;
      for (let phi = 0; phi < P; phi += 0.5) {
        let s = 0;
        let k = 0;
        for (let pos = phi; pos < n; pos += P, k++) s += o3[Math.round(pos)] ?? 0;
        s /= Math.max(1, k);
        if (s > best) {
          best = s;
          bestPhi = phi;
        }
      }
      return { score: best, phi: bestPhi };
    };
    // Coarse: autocorrelation over 55–200 BPM. Syncopated styles (phonk, trap) put strong peaks at
    // off-grid periods, so keep the several best peaks rather than trusting the single highest one.
    const lagMin = Math.floor((fps * 60) / 200);
    const lagMax = Math.ceil((fps * 60) / 55);
    const ac: number[] = [];
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += o[i]! * o[i + lag]!;
      ac[lag] = s / (n - lag);
    }
    const peaks: number[] = [];
    for (let lag = lagMin + 1; lag < lagMax; lag++) {
      if (ac[lag]! > ac[lag - 1]! && ac[lag]! >= ac[lag + 1]!) peaks.push(lag);
    }
    peaks.sort((a, b) => ac[b]! - ac[a]!);
    const centers = new Set<number>();
    for (const lag of peaks.slice(0, 6)) {
      const b = (60 * fps) / lag;
      for (const m of [1, 2, 0.5]) if (b * m >= 55 && b * m <= 200) centers.add(Math.round(b * m * 2) / 2);
    }
    if (centers.size) {
      // Fine: the beat grid that best lines up with the onsets wins (with a gentle preference for typical tempos).
      let top = { bpm: 0, score: -1, phi: 0 };
      for (const center of centers) {
        for (let b = center - 2.5; b <= center + 2.5; b += 0.05) {
          const c = comb((60 * fps) / b);
          const s = c.score * prior(b);
          if (s > top.score) top = { bpm: b, score: s, phi: c.phi };
        }
      }
      // Note: half-time styles (phonk, trap) often come out at half their written tempo — the grid still sits
      // exactly on the heavy hits, which is where edits cut anyway; get_beats can subdivide it for faster cuts.
      if (top.score > 0) {
        bpm = Math.round(top.bpm * 10) / 10;
        phase = top.phi;
      }
    }
  }
  const beats: number[] = [];
  if (bpm) {
    const P = (60 * fps) / bpm;
    for (let pos = phase; pos / fps < duration; pos += P) beats.push(Math.round((pos / fps) * 1000) / 1000);
  }

  // Loudness every 0.5 s, normalised to the track's own 95th percentile.
  const step = Math.round(rate * 0.5);
  const rms: number[] = [];
  for (let i = 0; i < x.length; i += step) {
    let s = 0;
    const end = Math.min(x.length, i + step);
    for (let j = i; j < end; j++) s += x[j]! * x[j]!;
    rms.push(Math.sqrt(s / Math.max(1, end - i)));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const energy = rms.map((v) => Math.round(Math.min(1, v / ref) * 100) / 100);

  // Drops: the biggest jumps in energy (4 s after vs 4 s before), snapped to a beat, ≥ 8 s apart.
  const at = (t: number) => energy[Math.max(0, Math.min(energy.length - 1, Math.floor(t / 0.5)))] ?? 0;
  const mean = (a: number, b: number) => {
    let s = 0;
    let k = 0;
    for (let t = a; t < b; t += 0.5, k++) s += at(t);
    return s / Math.max(1, k);
  };
  const candidates = (beats.length ? beats : energy.map((_, i) => i * 0.5))
    .filter((t) => t >= 4 && t <= duration - 4)
    .map((t) => ({ t, jump: mean(t, t + 4) - mean(t - 4, t), after: mean(t, t + 4) }))
    .filter((c) => c.jump > 0.18 && c.after > 0.55)
    .sort((a, b) => b.jump - a.jump);
  const drops: number[] = [];
  for (const c of candidates) {
    if (drops.length >= 4) break;
    if (drops.every((d) => Math.abs(d - c.t) >= 8)) drops.push(c.t);
  }
  drops.sort((a, b) => a - b);
  return { duration: Math.round(duration * 1000) / 1000, bpm, beats, energy, drops };
}

export async function analyzeFile(file: string): Promise<Analysis> {
  return analyzeSamples(await decodeMono(file, 11025), 11025);
}

// ---------------------------------------------------------------- library operations

export type TrackMeta = { title: string; artist?: string; genre?: string; moods?: string[]; license: MusicLicense; attribution?: string };

function cleanMeta(m: Partial<TrackMeta>) {
  return {
    title: (m.title ?? "").trim().slice(0, 120) || "Untitled track",
    artist: m.artist?.trim().slice(0, 80) || undefined,
    genre: (GENRES as readonly string[]).includes(m.genre ?? "") ? m.genre! : "other",
    moods: (m.moods ?? []).filter((x) => (MOODS as readonly string[]).includes(x)).slice(0, 5),
    attribution: m.attribution?.trim().slice(0, 300) || undefined,
  };
}

/** Move an uploaded file (in MUSIC_TMP) into the library and analyse it. */
export async function addTrack(tmpFile: string, ext: string, meta: TrackMeta): Promise<Track> {
  if (!(meta.license in LICENSES)) throw new Error("Choose where this music comes from (its licence).");
  const id = newId();
  mkdirSync(MUSIC_FILES, { recursive: true });
  const file = `${id}${ext.toLowerCase()}`;
  renameSync(tmpFile, path.join(MUSIC_FILES, file));
  try {
    const a = await analyzeFile(path.join(MUSIC_FILES, file));
    const t: Track = {
      id, file, ...cleanMeta(meta), ...a, license: meta.license, guideOnly: meta.license === "guide-only", addedAt: now(),
    };
    listTracks().unshift(t);
    saveLibrary();
    return t;
  } catch (e) {
    rmSync(path.join(MUSIC_FILES, file), { force: true });
    throw e;
  }
}

export function updateTrack(id: string, patch: Partial<TrackMeta>): Track {
  const t = getTrack(id);
  if (!t) throw new Error("track not found");
  const m = cleanMeta({ ...t, ...patch });
  Object.assign(t, m);
  if (patch.license && patch.license in LICENSES) {
    t.license = patch.license;
    t.guideOnly = patch.license === "guide-only";
  }
  saveLibrary();
  return t;
}

export function deleteTrack(id: string) {
  const t = getTrack(id);
  if (!t) return;
  cache = listTracks().filter((x) => x.id !== id);
  saveLibrary();
  rmSync(trackPath(t), { force: true }); // projects keep their own copy (hard link)
}

function wav16(samples: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return b;
}

/** Make an original track (owned by you, safe on every platform) and add it to the library. */
export async function generateTrack(style: GenStyle, opts: { bpm?: number; seconds?: number; seed?: number } = {}): Promise<Track> {
  if (!(style in GEN_STYLES)) throw new Error(`style must be one of ${Object.keys(GEN_STYLES).join(", ")}`);
  const seed = opts.seed ?? Math.floor(Math.random() * 1e6);
  const g = synthesize(style, { ...opts, seed });
  const id = newId();
  mkdirSync(MUSIC_TMP, { recursive: true });
  mkdirSync(MUSIC_FILES, { recursive: true });
  const wavFile = path.join(MUSIC_TMP, `${id}.wav`);
  writeFileSync(wavFile, wav16(g.samples, GEN_SAMPLE_RATE));
  const file = `${id}.m4a`;
  const proc = Bun.spawn([ffmpegPath(), "-v", "error", "-y", "-i", wavFile, "-c:a", "aac", "-b:a", "192k", path.join(MUSIC_FILES, file)], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  rmSync(wavFile, { force: true });
  if (code !== 0) throw new Error(`couldn't encode the track: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  const a = analyzeSamples(g.samples, GEN_SAMPLE_RATE); // energy curve; tempo/beats/drops are known exactly
  const info = GEN_STYLES[style];
  const t: Track = {
    id, file, title: `Original ${info.label.split(" (")[0]} · ${g.bpm} BPM · #${seed % 1000}`, duration: Math.round((g.samples.length / GEN_SAMPLE_RATE) * 1000) / 1000,
    bpm: g.bpm, beats: g.beats, energy: a.energy, drops: g.drops, genre: info.genre, moods: [...info.moods],
    license: "original", guideOnly: false, addedAt: now(), source: `generated ${style} seed ${seed}`,
  };
  listTracks().unshift(t);
  saveLibrary();
  return t;
}

export type MusicQuery = { query?: string; genre?: string; mood?: string; minBpm?: number; maxBpm?: number; includeGuide?: boolean };

/** Best matches first: genre/mood/words, then tempo window. */
export function searchTracks(q: MusicQuery = {}): Track[] {
  const words = (q.query ?? "").toLowerCase().split(/\W+/).filter(Boolean);
  return listTracks()
    .filter((t) => (q.includeGuide ?? true) || !t.guideOnly)
    .filter((t) => (q.minBpm === undefined || (t.bpm ?? 0) >= q.minBpm) && (q.maxBpm === undefined || (t.bpm ?? 999) <= q.maxBpm))
    .map((t) => {
      const hay = `${t.title} ${t.artist ?? ""} ${t.genre} ${t.moods.join(" ")}`.toLowerCase();
      const score = (q.genre && t.genre === q.genre ? 3 : 0) + (q.mood && t.moods.includes(q.mood) ? 2 : 0) + words.filter((w) => hay.includes(w)).length;
      return { t, score };
    })
    .filter((x) => x.score > 0 || (!q.genre && !q.mood && !words.length))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t);
}

/** Put a library track into a project as its own media (a hard link — no extra disk space). Reused if already there. */
export function importTrack(p: Project, t: Track): MediaRecord {
  const existing = p.media.find((m) => m.libraryTrackId === t.id);
  if (existing) return existing;
  const ext = path.extname(t.file) || ".m4a";
  const m: MediaRecord = {
    id: newId(), kind: "audio", name: t.title, original: `original${ext}`, width: 0, height: 0, duration: t.duration, fps: 0,
    hasAudio: true, size: statSync(trackPath(t)).size, addedAt: now(), source: { type: "upload" }, libraryTrackId: t.id,
    // Music never needs a transcript (lyrics would end up in the captions) — it's ready to use as is.
    steps: { probe: { state: "done" }, proxy: { state: "skipped" }, audio: { state: "skipped" }, transcript: { state: "skipped" }, silences: { state: "skipped" }, faces: { state: "skipped" }, enhance: { state: "skipped" } },
  };
  mkdirSync(mediaDir(p.id, m.id), { recursive: true });
  const dest = path.join(mediaDir(p.id, m.id), m.original);
  try {
    linkSync(trackPath(t), dest);
  } catch {
    copyFileSync(trackPath(t), dest);
  }
  p.media.push(m);
  saveProject(p);
  return m;
}

/** Make sure Claude always has something to work with: a few originals on first run. */
export async function ensureStarterMusic() {
  if (listTracks().length || existsSync(path.join(MUSIC_DIR, ".starter-done"))) return;
  mkdirSync(MUSIC_DIR, { recursive: true });
  for (const [style, seed] of [["phonk", 7], ["upbeat", 21], ["cinematic", 3], ["lofi", 12]] as const) {
    try {
      await generateTrack(style, { seconds: 95, seed });
    } catch (e) {
      console.warn(`  ! couldn't make starter music (${style}): ${(e as Error).message}`);
    }
  }
  writeFileSync(path.join(MUSIC_DIR, ".starter-done"), now());
}
