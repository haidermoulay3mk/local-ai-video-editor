// Motion gate: renders stills in the MIDDLE of every new transition / text animation / caption style /
// camera move and tiles them into contact sheets for inspection. Usage: bun scripts/motion-test.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath } from "../src/server/config";
import { safeJoin, serveFile } from "../src/server/files";
import { renderStillsJob, warmBundle } from "../src/server/render-client";
import { type CompositionProps, type MediaInfo, parseSpec, type SpecInput } from "../src/shared/spec";
import { layoutClips } from "../src/shared/timeline";

const dir = path.join(APP_HOME, "test", "motion");
mkdirSync(dir, { recursive: true });
const ff = (args: string[]) => {
  const r = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
if (!existsSync(path.join(dir, "img.png"))) {
  ff(["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "a.mp4")]);
  ff(["-f", "lavfi", "-i", "mandelbrot=s=1280x720:r=30", "-t", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "b.mp4")]);
  ff(["-f", "lavfi", "-i", "gradients=s=1080x1080:d=1", "-frames:v", "1", path.join(dir, "img.png")]);
}

const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    const file = safeJoin(dir, decodeURIComponent(new URL(req.url).pathname.slice(1)));
    return file ? serveFile(req, file) : new Response("bad path", { status: 400 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const mk = (id: string, kind: MediaInfo["kind"], file: string, w: number, h: number, d: number): MediaInfo => ({
  id, kind, name: file, src: `${base}/${file}`, width: w, height: h, duration: d, fps: 30, hasAudio: false,
});
const media = { A: mk("A", "video", "a.mp4", 1280, 720, 12), B: mk("B", "video", "b.mp4", 1280, 720, 12), I: mk("I", "image", "img.png", 1080, 1080, 0) };

const TRANSITIONS = ["zoomPunch", "glitch", "spin", "flash", "smoothSlide", "shutter"] as const;
const ANIMS = ["rise", "stagger", "elastic", "glitch", "scaleBlur", "blurUp"] as const;
const CAPS = ["hormozi", "single", "gradient", "outline"] as const;
const clipLen = 1.6;
const words = "this is how the new captions look when you talk fast and clear on camera today".split(" ")
  .map((text, i) => ({ text, start: 0.1 + i * 0.32, end: 0.1 + i * 0.32 + 0.28 }));

const specInput = (captionStyle: (typeof CAPS)[number]): SpecInput => ({
  format: { preset: "short", width: 1080, height: 1920, fps: 30 },
  clips: [
    { id: "c0", mediaId: "A", in: 0, out: clipLen, motion: { type: "punch", amount: 0.15 } },
    ...TRANSITIONS.map((t, i) => ({
      id: `c${i + 1}`,
      mediaId: i === 2 ? "I" : i % 2 ? "A" : "B",
      in: i % 2 ? (i + 1) * clipLen : 0,
      out: i % 2 ? (i + 2) * clipLen : clipLen,
      transition: { type: t, duration: 0.5, direction: "left" as const },
      motion: i === 4 ? { type: "panLeft" as const, amount: 0.2 } : undefined,
    })),
  ],
  overlays: ANIMS.map((an, i) => ({
    type: "text" as const, id: `t${i}`, start: 0.2 + i * 1.4, end: 1.4 + i * 1.4, text: `${an.toUpperCase()} TEXT ANIMATION`,
    y: 0.25, anim: { in: an, out: "fade" as const, duration: 0.5 },
    style: { font: "Bangers" as const, size: 96, color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 6 },
  })),
  captions: { enabled: true, style: captionStyle, y: 0.72, maxWordsPerPage: 3 },
});

let ok = true;
try {
  await warmBundle().done;
  const props = (style: (typeof CAPS)[number]): CompositionProps => ({
    spec: parseSpec(specInput(style)), media, analysis: { A: { words } }, preview: false, sfxBaseUrl: `${base}/sfx`,
  });
  const layouts = layoutClips(props("hormozi").spec);
  const fps = 30;
  // Transitions: 30% and 70% through each overlap (either side of the midpoint cut).
  const tTimes = layouts.filter((l) => l.transitionFrames > 0)
    .flatMap((l) => [0.3, 0.7].map((k) => (l.startFrame + k * l.transitionFrames) / fps));
  // Text animations: 0.12 s and 0.3 s into each entrance.
  const aTimes = ANIMS.flatMap((_, i) => [0.2 + i * 1.4 + 0.12, 0.2 + i * 1.4 + 0.3]);
  // Camera: start and end of the punch clip, the photo (default push-in), and the pan clip.
  const img = layouts.find((l) => l.clip.id === "c3")!;
  const pan = layouts.find((l) => l.clip.id === "c5")!;
  const cTimes = [0.05, 0.9, img.start + 0.55, img.end - 0.55, pan.start + 0.55, pan.end - 0.55];
  const out = path.join(dir, "stills");
  rmSync(out, { recursive: true, force: true });
  // `bun scripts/motion-test.ts probe 2.1 2.7` renders every frame in that range instead (debugging aid).
  const [mode, from, to] = process.argv.slice(2);
  const probe = mode === "probe" ? Array.from({ length: Math.min(24, Math.round((Number(to) - Number(from)) * fps) + 1) }, (_, k) => Number(from) + k / fps) : null;
  const groups: Record<string, string[]> = probe ? { probe: await renderStillsJob(props("hormozi"), probe, path.join(out, "probe"), 0.3).done } : {
    transitions: await renderStillsJob(props("hormozi"), tTimes, path.join(out, "transitions"), 0.3).done,
    animations: await renderStillsJob(props("hormozi"), aTimes, path.join(out, "animations"), 0.3).done,
    camera: await renderStillsJob(props("hormozi"), cTimes, path.join(out, "camera"), 0.3).done,
    captions: [],
  };
  // Mid-word on page 1 (clip c0 = media A, no transition), then mid-word on page 2.
  const capT = [words[1]!.start + 0.12, words[4]!.start + 0.05];
  if (groups.captions) for (const st of CAPS) groups.captions.push(...(await renderStillsJob(props(st), capT, path.join(out, `cap-${st}`), 0.3).done));

  for (const [name, files] of Object.entries(groups)) {
    const cols = Math.min(6, files.length);
    const sheet = path.join(dir, `sheet-${name}.jpg`);
    const scale = files.map((_, i) => `[${i}:v]scale=270:480[s${i}]`).join(";");
    const layout = files.map((_, i) => `${(i % cols) * 270}_${Math.floor(i / cols) * 480}`).join("|");
    ff([...files.flatMap((f) => ["-i", f]), "-filter_complex",
      `${scale};${files.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${files.length}:layout=${layout}:fill=black`, "-frames:v", "1", sheet]);
    console.log(`${name}: ${files.length} stills -> ${sheet}`);
  }
  console.log("order - transitions:", TRANSITIONS.join(", "), "(30%/70% each); animations:", ANIMS.join(", "),
    "(0.12s/0.3s each); camera: punch start/end, photo start/end, pan start/end; captions:", CAPS.join(", "), "(2 each)");
} catch (e) {
  ok = false;
  console.error(e);
} finally {
  server.stop(true);
}
console.log(ok ? "\nMOTION STILLS RENDERED" : "\nMOTION GATE: FAIL");
process.exit(ok ? 0 : 1);
