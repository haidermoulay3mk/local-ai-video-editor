// Phase 1 gate: render a spec that uses every layer type, then extract frames for inspection.
// Usage: bun scripts/engine-test.ts
import { mkdirSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath, ffprobePath } from "../src/server/config";
import { serveFile, safeJoin } from "../src/server/files";
import { renderVideoJob, warmBundle } from "../src/server/render-client";
import { type CompositionProps, type FaceTrack, type MediaInfo, parseSpec } from "../src/shared/spec";
import { totalSeconds } from "../src/shared/timeline";

const dir = path.join(APP_HOME, "test");
mkdirSync(dir, { recursive: true });

function ff(args: string[]) {
  const r = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

console.log("1/4 generating synthetic media...");
ff(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=8", "-f", "lavfi", "-i", "sine=f=330:d=8",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "a.mp4")]);
ff(["-f", "lavfi", "-i", "mandelbrot=s=1280x720:r=30", "-t", "6", "-f", "lavfi", "-i", "sine=f=550:d=6",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "b.mp4")]);
ff(["-f", "lavfi", "-i", "aevalsrc=0.4*sin(2*PI*(220+40*sin(2*PI*0.5*t))*t):d=5:s=44100", path.join(dir, "music.wav")]);
ff(["-f", "lavfi", "-i", "gradients=s=800x600:d=1", "-frames:v", "1", path.join(dir, "img.png")]);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const rel = decodeURIComponent(new URL(req.url).pathname.slice(1));
    const file = safeJoin(dir, rel);
    return file ? serveFile(req, file) : new Response("bad path", { status: 400 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const mk = (id: string, kind: MediaInfo["kind"], file: string, w: number, h: number, d: number, audio: boolean): MediaInfo => ({
  id, kind, name: file, src: `${base}/${file}`, width: w, height: h, duration: d, fps: 30, hasAudio: audio,
});
const media: Record<string, MediaInfo> = {
  A: mk("A", "video", "a.mp4", 1920, 1080, 8, true),
  B: mk("B", "video", "b.mp4", 1280, 720, 6, true),
  M: mk("M", "audio", "music.wav", 0, 0, 5, true),
  I: mk("I", "image", "img.png", 800, 600, 0, false),
};

// Fake face drifting left->right across clip A so face-reframe / retouch / face-zoom code paths run.
const samples: (number[] | null)[] = [];
for (let i = 0; i < 40; i++) {
  const cx = 0.35 + 0.3 * (i / 40), cy = 0.45;
  samples.push([cx, cy, 0.16, 0.28, cx - 0.035, cy - 0.04, cx + 0.035, cy - 0.04, cx - 0.03, cy + 0.07, cx + 0.03, cy + 0.07]);
}
const faces: FaceTrack = { sampleFps: 5, samples };
const words = "this is my editor rendering captions with a bold highlight style for the engine gate test"
  .split(" ")
  .map((text, i) => ({ text, start: 0.2 + i * 0.4, end: 0.2 + i * 0.4 + 0.32 }));

const spec = parseSpec({
  format: { preset: "short", width: 1080, height: 1920, fps: 30 },
  clips: [
    { id: "c1", mediaId: "A", in: 0, out: 4 },
    { id: "c2", mediaId: "B", in: 0, out: 3, transition: { type: "whip", duration: 0.4, direction: "left" } },
    { id: "c3", mediaId: "A", in: 4, out: 8, speed: 2, transition: { type: "zoom", duration: 0.4 } },
  ],
  overlays: [
    { type: "template", id: "title", start: 0, end: 1.8, template: "titleCard", props: { title: "Engine Test", subtitle: "every layer type", backdrop: true } },
    { type: "text", id: "t1", start: 2, end: 4, text: "Gradient text ✨", y: 0.18, style: { font: "Bangers", size: 110, gradient: ["#FFD400", "#FF2D55"] } },
    { type: "shape", id: "s1", start: 2, end: 4, shape: "arrow", x: 0.2, y: 0.3, x2: 0.45, y2: 0.4, color: "#00E5FF", draw: true, strokeWidth: 12 },
    { type: "shape", id: "s2", start: 2.2, end: 4, shape: "highlight", x: 0.5, y: 0.18, w: 0.7, h: 0.07, draw: true },
    { type: "image", id: "i1", start: 4, end: 6, mediaId: "I", x: 0.75, y: 0.22, w: 0.35, border: "#fff" },
    { type: "video", id: "v1", start: 4, end: 6.5, mediaId: "B", in: 1, x: 0.25, y: 0.22, w: 0.4, shape: "circle", border: "#FFD400" },
    { type: "faceCam", id: "fc", start: 6.2, end: 8, x: 0.8, y: 0.15 },
    { type: "template", id: "sub", start: 5.5, end: 7.8, template: "subscribe", props: { channel: "@yourhandle" } },
    { type: "template", id: "lt", start: 1.9, end: 4, template: "lowerThird", props: { name: "Sam Lee", title: "Founder" } },
    { type: "template", id: "kw", start: 4.1, end: 5.2, template: "keyword", props: { text: "BOOM" } },
    { type: "template", id: "cnt", start: 6.6, end: 8, template: "counter", props: { to: 12500, prefix: "$", label: "saved" }, y: 0.45 },
    { type: "template", id: "pb", start: 0, end: 8.2, template: "progressBar", z: 200, props: { position: "top" } },
  ],
  captions: { enabled: true, style: "bold", y: 0.7, emphasis: [{ word: "bold", color: "#00E5FF", emoji: "🔥" }] },
  audio: { music: [{ id: "mu", mediaId: "M", volume: 0.5, duckTo: 0.3 }], sfx: [] },
  grade: { preset: "cinematic", grain: 0.4, lightLeak: 0.5 },
  effects: [
    { id: "e1", type: "zoom", start: 1, end: 1.8, intensity: 0.6, focus: "face" },
    { id: "e2", type: "shake", start: 4.1, end: 4.6, intensity: 0.8 },
    { id: "e3", type: "flash", start: 3.6, end: 4 },
    { id: "e4", type: "rgbSplit", start: 4.6, end: 5.1 },
  ],
  retouch: { skinSmooth: 0.6, faceLight: 0.5 },
});

const props: CompositionProps = { spec, media, analysis: { A: { words, faces } }, preview: false, sfxBaseUrl: `${base}/sfx` };

// Bundle first (cached on disk) so the timing below is pure rendering.
let t0 = Date.now();
await warmBundle().done;
console.log(`   bundle ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const out = path.join(dir, "engine-test.mp4");
console.log(`2/4 rendering ${totalSeconds(spec).toFixed(2)}s (${spec.format.width}x${spec.format.height}) -> ${out}`);
t0 = Date.now();
let lastPct = -10;
const job = renderVideoJob(props, out, (p) => {
  const pct = Math.floor(p.progress * 100);
  if (pct >= lastPct + 10) {
    lastPct = pct;
    console.log(`   ${pct}% (rendered ${p.rendered}, encoded ${p.encoded})`);
  }
});
await job.done;
console.log(`   done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log("3/4 probing output...");
const probe = Bun.spawnSync([ffprobePath(), "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", out]);
console.log(probe.stdout.toString());

console.log("4/4 extracting frames for inspection...");
for (const t of [0.6, 1.4, 2.6, 3.95, 4.3, 5.0, 6.0, 7.2]) {
  ff(["-ss", String(t), "-i", out, "-frames:v", "1", "-vf", "scale=540:-1", path.join(dir, `frame-${t.toFixed(2)}.png`)]);
}
console.log(`frames in ${dir}`);
server.stop(true);
process.exit(0);
