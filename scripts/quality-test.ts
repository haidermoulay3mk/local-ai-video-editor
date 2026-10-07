// Quality gate: footage health analysis + auto-fix, and export loudness mastering.
// Usage: bun scripts/quality-test.ts
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath } from "../src/server/config";
import { analyzeLook, autoFixOptions, fixFootage } from "../src/server/look";
import { masterAudio, measureLoudness } from "../src/server/media";

const dir = path.join(APP_HOME, "test", "quality");
mkdirSync(dir, { recursive: true });
const ff = (args: string[]) => {
  const r = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
let ok = true;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) ok = false;
};

const face = path.join(APP_HOME, "test", "astronaut.png");
if (!existsSync(face)) await Bun.write(face, await fetch("https://raw.githubusercontent.com/scikit-image/scikit-image/v0.19.3/skimage/data/astronaut.png"));

// 1. A dark, orange-tinted, handheld-shaky clip vs the same picture steady and well exposed.
const shaky = path.join(dir, "shaky-dark.mp4");
const steady = path.join(dir, "steady.mp4");
ff(["-loop", "1", "-i", face, "-t", "8", "-r", "30", "-vf",
  "scale=1200:1200,crop=1080:1080:x='60+22*sin(n*2.3)+14*sin(n*5.1)':y='60+20*cos(n*1.9)+12*sin(n*4.3)',scale=720:720,eq=brightness=-0.2:contrast=0.85,colorbalance=rm=0.16:bm=-0.12,format=yuv420p",
  "-c:v", "libx264", "-crf", "18", shaky]);
ff(["-loop", "1", "-i", face, "-t", "8", "-r", "30", "-vf", "scale=720:720,format=yuv420p", "-c:v", "libx264", "-crf", "18", steady]);

const bad = await analyzeLook(shaky, dir);
const good = await analyzeLook(steady, dir);
console.log("shaky/dark:", JSON.stringify(bad));
console.log("steady:   ", JSON.stringify(good));
check(bad.advice.stabilize && (bad.shake ?? 0) > 0.35, `shake detected on the handheld clip (${bad.shake}%)`);
check(!good.advice.stabilize && (good.shake ?? 1) < 0.1, `no shake on the steady clip (${good.shake}%)`);
check(bad.exposure < 0.36 && (bad.advice.color?.gamma ?? 1) > 1, `dark exposure detected (${bad.exposure}) → gamma ${bad.advice.color?.gamma}`);
check(bad.warmth > 5 && !!bad.advice.whiteBalance, `orange tint noted (warmth ${bad.warmth}) → white-balance shift ${JSON.stringify(bad.advice.whiteBalance)}`);
check(!autoFixOptions(good)?.whiteBalance, "a naturally warm, well-exposed shot is NOT auto-colour-corrected");

// 2. Fix it (white balance on request, as Claude would after checking a frame), then measure again.
const t0 = Date.now();
await fixFootage(shaky, path.join(dir, "fixed.mp4"), dir, bad, { stabilize: true, denoise: bad.advice.denoise, color: true, whiteBalance: true }, 8);
const fixed = await analyzeLook(path.join(dir, "fixed.mp4"), dir);
console.log(`fixed in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(fixed));
check((fixed.shake ?? 9) < (bad.shake ?? 0) * 0.5, `stabilized: jitter ${bad.shake}% → ${fixed.shake}%`);
check(fixed.exposure > bad.exposure + 0.05, `brighter: exposure ${bad.exposure} → ${fixed.exposure}`);
check(Math.abs(fixed.warmth) < Math.abs(bad.warmth) * 0.75, `tint reduced: warmth ${bad.warmth} → ${fixed.warmth}`);

// 3. Loudness mastering of a too-quiet export.
const quiet = path.join(dir, "quiet.mp4");
ff(["-f", "lavfi", "-i", "color=c=0x223344:s=320x240:r=30:d=6", "-f", "lavfi", "-i", "sine=f=330:d=6:sample_rate=48000",
  "-af", "volume=0.05", "-shortest", "-c:v", "libx264", "-c:a", "aac", quiet]);
const before = await measureLoudness(quiet);
const res = await masterAudio(quiet);
console.log("loudness:", JSON.stringify({ before: before?.I, res }));
check(!!res && Math.abs(res.after + 14) <= 1, `export mastered to ${res?.after} LUFS (target -14, was ${res?.before})`);

console.log(ok ? "\nQUALITY GATE: PASS" : "\nQUALITY GATE: FAIL");
process.exit(ok ? 0 : 1);
