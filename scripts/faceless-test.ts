// Faceless-formats gate: renders stills of the social templates (post card, chat, versus, end screen, Q&A,
// animated backgrounds) and the split-screen layout, then tiles them into contact sheets for inspection.
// Usage: bun scripts/faceless-test.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath } from "../src/server/config";
import { safeJoin, serveFile } from "../src/server/files";
import { renderStillsJob, warmBundle } from "../src/server/render-client";
import { type CompositionProps, type MediaInfo, parseSpec, type SpecInput } from "../src/shared/spec";

const dir = path.join(APP_HOME, "test", "faceless");
mkdirSync(dir, { recursive: true });
const ff = (args: string[]) => {
  const r = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
if (!existsSync(path.join(dir, "avatar.png"))) {
  ff(["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "a.mp4")]);
  ff(["-f", "lavfi", "-i", "mandelbrot=s=1280x720:r=30", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "b.mp4")]);
  ff(["-f", "lavfi", "-i", "gradients=s=400x400:c0=0xff8a00:c1=0x7b2ff7:d=1", "-frames:v", "1", path.join(dir, "avatar.png")]);
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
const media = { A: mk("A", "video", "a.mp4", 1280, 720, 8), B: mk("B", "video", "b.mp4", 1280, 720, 5), AV: mk("AV", "image", "avatar.png", 400, 400, 0) };
const brand = { name: "Test Creator", handle: "@testcreator", avatar: "AV", colors: ["#FFD400", "#FF2D95"] };
const tpl = (id: string, template: string, start: number, end: number, props: Record<string, string | number | boolean>, extra: object = {}) =>
  ({ type: "template" as const, id, template: template as "chat", start, end, props, ...extra });

const tall: SpecInput = {
  format: { preset: "short", width: 1080, height: 1920, fps: 30 },
  brand,
  clips: [{ id: "c1", mediaId: "A", in: 0, out: 8 }],
  overlays: [
    tpl("bg1", "background", 0, 4, { style: "gradient" }, { z: -10 }),
    tpl("post", "postCard", 0, 2, { community: "r/stories", user: "throwaway_2291", title: "I found a hidden room behind my closet and you won't believe what was inside", body: "So this happened last weekend. I was repainting my bedroom when I noticed the wall behind the closet sounded hollow. My landlord said there was nothing there, but…", votes: 24800, comments: 1312 }),
    tpl("tweet", "postCard", 2, 4, { style: "social", user: "Test Creator", text: "Nobody tells you this: consistency beats talent when talent stops showing up.", verified: true, votes: 45200, reposts: 3100, comments: 902, views: 1200000 }),
    tpl("bg2", "background", 4, 9, { style: "aurora" }, { z: -10 }),
    tpl("chat", "chat", 4, 9, { contact: "Sam", perMessage: 0.4, messages: "me: you up?|Sam: it's 3am why|me: I need to tell you something|me: promise you won't be mad|Sam: …what did you do|me: I may have accidentally adopted 3 cats|Sam: THREE??|me: they were on sale|Sam: you live in a studio apartment|me: they like the windowsill|Sam: I'm coming over|me: bring treats" }),
    tpl("vs", "versus", 9, 11, { left: "Cats", right: "Dogs", leftSub: "independent", rightSub: "loyal" }),
    tpl("bg3", "background", 11, 13, { style: "rays" }, { z: -10 }),
    tpl("q", "question", 11, 13, { text: "How do you stay consistent when you have zero motivation?" }),
    tpl("bg4", "background", 13, 14.5, { style: "particles" }, { z: -10 }),
    tpl("bg5", "background", 14.5, 16, { style: "grid" }, { z: -10 }),
    tpl("end", "endScreen", 15.2, 17, {}),
  ],
};
const wide: SpecInput = {
  format: { preset: "youtube", width: 1920, height: 1080, fps: 30 },
  brand,
  clips: [{ id: "c1", mediaId: "A", in: 0, out: 4 }],
  overlays: [tpl("vs", "versus", 0, 2, { left: "iPhone", right: "Android", leftImage: "AV" }), tpl("end", "endScreen", 2, 4, {})],
};
const split: SpecInput = {
  format: { preset: "short", width: 1080, height: 1920, fps: 30 },
  clips: [{ id: "c1", mediaId: "A", in: 0, out: 6, motion: { type: "pushIn", amount: 0.1 } }],
  layout: { mode: "split", mediaId: "B", ratio: 0.5, divider: "#FFFFFF" },
  captions: { enabled: true, style: "hormozi", y: 0.5 },
};
const words = "this is what a split screen short looks like with captions on the seam".split(" ")
  .map((text, i) => ({ text, start: 0.1 + i * 0.35, end: 0.1 + i * 0.35 + 0.3 }));

let ok = true;
try {
  await warmBundle().done;
  const props = (s: SpecInput): CompositionProps => ({ spec: parseSpec(s), media, analysis: { A: { words } }, preview: false, sfxBaseUrl: `${base}/sfx` });
  const out = path.join(dir, "stills");
  rmSync(out, { recursive: true, force: true });
  const groups: Record<string, string[]> = {
    tall: await renderStillsJob(props(tall), [0.25, 1.7, 3.5, 4.9, 6.6, 8.8, 9.3, 10.2, 12.4, 13.8, 14.8, 16.6], path.join(out, "tall"), 0.3).done,
    wide: await renderStillsJob(props(wide), [0.3, 1.2, 3.5], path.join(out, "wide"), 0.25).done,
    split: await renderStillsJob(props(split), [0.5, 2.2, 5.6], path.join(out, "split"), 0.3).done,
  };
  for (const [name, files] of Object.entries(groups)) {
    const isWide = name === "wide";
    const tw = isWide ? 480 : 270, th = isWide ? 270 : 480;
    const cols = Math.min(isWide ? 3 : 6, files.length);
    const sheet = path.join(dir, `sheet-${name}.jpg`);
    const scale = files.map((_, i) => `[${i}:v]scale=${tw}:${th}[s${i}]`).join(";");
    const layout = files.map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * th}`).join("|");
    ff([...files.flatMap((f) => ["-i", f]), "-filter_complex",
      `${scale};${files.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${files.length}:layout=${layout}:fill=black`, "-frames:v", "1", sheet]);
    console.log(`${name}: ${files.length} stills -> ${sheet}`);
  }
} catch (e) {
  ok = false;
  console.error(e);
} finally {
  server.stop(true);
}
console.log(ok ? "\nFACELESS STILLS RENDERED" : "\nFACELESS GATE: FAIL");
process.exit(ok ? 0 : 1);
