// Footage health: measure exposure / contrast / colour cast / camera shake, and fix what's off
// (stabilize, denoise, auto exposure + white balance, sharpen) into a new render source. The
// original file is never touched. Pure helpers are exported for tests.
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ffmpegPath } from "./config";
import { run } from "./media";

export type ColorFix = { gamma: number; contrast: number; saturation: number };
/** White-balance shift in 8-bit chroma units (subtracted from U / V). */
export type WbFix = { du: number; dv: number; strong: boolean };

export type LookAnalysis = {
  exposure: number; // mean luma 0..1 (0.45 ~ well exposed)
  spread: number; // 10th-90th percentile luma range 0..1 (low = flat / washed out)
  warmth: number; // + orange cast, - blue cast (chroma units, ~±4 is neutral)
  green: number; // + green cast, - magenta cast
  saturation: number; // mean saturation (chroma units)
  shake: number | null; // jitter, % of frame width per frame (null = not measured)
  advice: {
    stabilize: boolean;
    denoise: boolean;
    color: ColorFix | null; // exposure / contrast / saturation — safe to apply automatically
    // Averages can't tell a colour cast from a genuinely warm/cool scene (sunset, orange shirt), so white
    // balance is applied automatically only when `strong`; otherwise it's a suggestion to check on a frame.
    whiteBalance: WbFix | null;
    notes: string[];
  };
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Average the per-frame `signalstats` values printed by ffmpeg's metadata filter. */
export function parseSignalstats(stderr: string): { y: number; low: number; high: number; u: number; v: number; sat: number } | null {
  const sums: Record<string, number[]> = {};
  for (const m of stderr.matchAll(/lavfi\.signalstats\.(YAVG|YLOW|YHIGH|UAVG|VAVG|SATAVG)=([\d.]+)/g)) {
    (sums[m[1]!] ??= []).push(Number(m[2]));
  }
  const mean = (k: string) => {
    const a = sums[k];
    return a?.length ? a.reduce((s, x) => s + x, 0) / a.length : Number.NaN;
  };
  const y = mean("YAVG");
  if (!Number.isFinite(y)) return null;
  return { y, low: mean("YLOW"), high: mean("YHIGH"), u: mean("UAVG"), v: mean("VAVG"), sat: mean("SATAVG") };
}

/**
 * Camera jitter from vid.stab's global_motions.trf ("<n> dx dy alpha zoom flag" per frame, '#' comments).
 * Intentional pans are smooth; shake is what's left after removing a moving average.
 */
export function shakeFromMotions(text: string, width: number): number {
  const dx: number[] = [];
  const dy: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const f = line.trim().split(/\s+/).map(Number);
    if (f.length >= 3 && f.every((x) => Number.isFinite(x))) {
      dx.push(f[1]!);
      dy.push(f[2]!);
    }
  }
  if (dx.length < 5 || width <= 0) return 0;
  const W = 4; // ±4 frames ≈ 0.27 s at 30 fps
  let sum = 0;
  for (let i = 0; i < dx.length; i++) {
    let mx = 0, my = 0, n = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(dx.length - 1, i + W); j++) {
      mx += dx[j]!;
      my += dy[j]!;
      n++;
    }
    sum += Math.hypot(dx[i]! - mx / n, dy[i]! - my / n);
  }
  return r2((100 * sum) / dx.length / width);
}

/** Turn raw stats into a verdict + the exact fixes worth applying. */
export function lookAdvice(s: { y: number; low: number; high: number; u: number; v: number; sat: number }, shake: number | null): LookAnalysis {
  const exposure = clamp((s.y - 16) / 219, 0, 1);
  const spread = clamp((s.high - s.low) / 219, 0, 1);
  const u = s.u - 128, v = s.v - 128;
  const warmth = (v - u) / 2;
  const green = -(u + v) / 2;
  const notes: string[] = [];
  let gamma = 1, contrast = 1, saturation = 1;
  if (exposure < 0.36) {
    gamma = clamp(1 + (0.45 - exposure) * 2.2, 1, 1.6);
    notes.push(`dark (exposure ${r2(exposure)})`);
  } else if (exposure > 0.68) {
    gamma = clamp(1 - (exposure - 0.58) * 0.9, 0.78, 1);
    notes.push(`bright (exposure ${r2(exposure)})`);
  }
  if (spread < 0.42) {
    contrast = clamp(1 + (0.52 - spread) * 0.7, 1, 1.25);
    notes.push("flat / washed out");
  }
  if (s.sat < 14) {
    saturation = 1.18;
    notes.push("dull colours");
  }
  // Gray-world white balance: correct half of the chroma offset beyond a neutral band of 6.
  const dev = Math.hypot(u, v);
  let whiteBalance: WbFix | null = null;
  if (dev > 8) {
    const part = (x: number) => Math.sign(x) * Math.max(0, Math.abs(x) - 6) * 0.5;
    whiteBalance = { du: Math.round(part(u)), dv: Math.round(part(v)), strong: dev > 25 };
    if (whiteBalance.du === 0 && whiteBalance.dv === 0) whiteBalance = null;
    else notes.push(`${warmth > 0 ? "warm/orange" : "cool/blue"}${Math.abs(green) > 5 ? (green > 0 ? " + green" : " + magenta") : ""} tint${whiteBalance.strong ? " (strong)" : " (may be the scene itself)"}`);
  }
  const colorNeeded = gamma !== 1 || contrast !== 1 || saturation !== 1;
  const stabilize = shake !== null && shake > 0.35;
  if (stabilize) notes.push(`shaky (${shake}% jitter)`);
  const denoise = exposure < 0.3;
  if (denoise) notes.push("low light → likely noisy");
  return {
    exposure: r2(exposure), spread: r2(spread), warmth: r2(warmth), green: r2(green), saturation: r2(s.sat), shake,
    advice: {
      stabilize, denoise,
      color: colorNeeded ? { gamma: r2(gamma), contrast: r2(contrast), saturation: r2(saturation) } : null,
      whiteBalance,
      notes,
    },
  };
}

/** Measure a video (use the light proxy — it's plenty for statistics and much faster). */
export async function analyzeLook(src: string, workDir: string, maxSeconds = 120): Promise<LookAnalysis> {
  const t = String(maxSeconds);
  const stats = await run([ffmpegPath(), "-hide_banner", "-nostats", "-t", t, "-i", src, "-vf", "fps=2,scale=320:-2,signalstats,metadata=mode=print", "-f", "null", "-"]);
  const s = parseSignalstats(stats.stderr);
  if (!s) throw new Error("could not read picture statistics");
  let shake: number | null = null;
  const trf = path.join(workDir, "look.trf");
  const motions = path.join(workDir, "global_motions.trf");
  try {
    // vid.stab writes its files relative to the working directory; both passes run at 320 px wide.
    const detect = await run([ffmpegPath(), "-hide_banner", "-nostats", "-loglevel", "error", "-t", t, "-i", src, "-vf", "scale=320:-2,vidstabdetect=shakiness=8:accuracy=9:result=look.trf", "-f", "null", "-"], undefined, undefined, workDir);
    if (detect.code === 0) {
      await run([ffmpegPath(), "-hide_banner", "-nostats", "-loglevel", "error", "-t", t, "-i", src, "-vf", "scale=320:-2,vidstabtransform=input=look.trf:debug=1", "-f", "null", "-"], undefined, undefined, workDir);
      if (existsSync(motions)) shake = shakeFromMotions(readFileSync(motions, "utf8"), 320);
    }
  } finally {
    rmSync(trf, { force: true });
    rmSync(motions, { force: true });
  }
  return lookAdvice(s, shake);
}

export type FixOptions = { stabilize?: boolean; denoise?: boolean; color?: boolean; whiteBalance?: boolean; sharpen?: boolean };

/** What to fix without asking: everything advised, white balance only when the cast is strong. */
export function autoFixOptions(look: LookAnalysis): FixOptions | null {
  const a = look.advice;
  const o: FixOptions = { stabilize: a.stabilize, denoise: a.denoise, color: !!a.color, whiteBalance: !!a.whiteBalance?.strong };
  return o.stabilize || o.denoise || o.color || o.whiteBalance ? o : null;
}

/** The ffmpeg filter chain for a fix (stabilization's detect pass runs separately). */
export function fixFilterChain(look: LookAnalysis, o: FixOptions): string {
  const f: string[] = [];
  if (o.stabilize) f.push("vidstabtransform=input=fix.trf:smoothing=18:optzoom=1:zoomspeed=0.2:interpol=bicubic");
  if (o.denoise) f.push("hqdn3d=1.5:1.5:6:6");
  const c = look.advice.color;
  const wb = look.advice.whiteBalance;
  if ((o.color && c) || (o.whiteBalance && wb)) f.push("format=yuv420p"); // 8-bit for the lookups below
  if (o.color && c) f.push(`eq=gamma=${c.gamma}:contrast=${c.contrast}:saturation=${c.saturation}`);
  if (o.whiteBalance && wb) f.push(`lutyuv=u=val-(${wb.du}):v=val-(${wb.dv})`);
  if (o.sharpen || o.stabilize) f.push("cas=0.35"); // stabilization's resampling softens a little
  f.push("scale=trunc(iw/2)*2:trunc(ih/2)*2", "format=yuv420p");
  return f.join(",");
}

/** Write the fixed copy (video re-encoded at high quality, audio copied untouched so timings never change). */
export async function fixFootage(src: string, dst: string, workDir: string, look: LookAnalysis, o: FixOptions, duration: number, onProgress?: (p: number) => void) {
  const progress = (base: number, span: number) => (chunk: string) => {
    const m = /out_time_us=(\d+)/.exec(chunk);
    if (m && duration > 0) onProgress?.(base + span * Math.min(1, Number(m[1]) / 1e6 / duration));
  };
  const trf = path.join(workDir, "fix.trf");
  try {
    if (o.stabilize) {
      const d = await run([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", "-i", src, "-vf", "vidstabdetect=shakiness=6:accuracy=12:result=fix.trf", "-f", "null", "-"], undefined, progress(0, 0.4), workDir);
      if (d.code !== 0) throw new Error(`stabilize (detect) failed: ${d.stderr.trim().split("\n").slice(-2).join(" | ")}`);
    }
    const base = o.stabilize ? 0.4 : 0;
    const res = await run(
      [ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", "-i", src,
        "-map", "0:v:0", "-map", "0:a?", "-vf", fixFilterChain(look, o), "-c:v", "libx264", "-preset", "fast", "-crf", "16",
        "-c:a", "copy", "-movflags", "+faststart", path.basename(dst)],
      undefined, progress(base, 1 - base), workDir,
    );
    if (res.code !== 0) throw new Error(`fix failed: ${res.stderr.trim().split("\n").slice(-2).join(" | ")}`);
  } finally {
    rmSync(trf, { force: true });
  }
}
