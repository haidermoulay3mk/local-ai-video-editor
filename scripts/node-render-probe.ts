// Diagnostic: does Remotion render reliably under Node (vs Bun)? And which GL mode is faster here?
// Usage: node --import tsx scripts/node-render-probe.ts
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { APP_HOME } from "../src/server/config";
import { getBundle, renderVideo } from "../src/server/render";
import { type CompositionProps, parseSpec } from "../src/shared/spec";

const dir = path.join(APP_HOME, "test");
const server = http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent((req.url ?? "/").slice(1)));
  if (!file.startsWith(dir) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Length": statSync(file).size, "Access-Control-Allow-Origin": "*" });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const spec = parseSpec({
  format: { preset: "short", width: 1080, height: 1920, fps: 30 },
  clips: [
    { id: "c1", mediaId: "A", in: 0, out: 2 },
    { id: "c2", mediaId: "B", in: 0, out: 2, transition: { type: "fade", duration: 0.4 } },
  ],
  overlays: [{ type: "template", id: "t", start: 0, end: 3, template: "titleCard", props: { title: "Probe" } }],
  grade: { preset: "cinematic", grain: 0.4 },
});
const props: CompositionProps = {
  spec,
  media: {
    A: { id: "A", kind: "video", name: "a", src: `${base}/a.mp4`, width: 1920, height: 1080, duration: 8, fps: 30, hasAudio: true },
    B: { id: "B", kind: "video", name: "b", src: `${base}/b.mp4`, width: 1280, height: 720, duration: 6, fps: 30, hasAudio: true },
  },
  analysis: {},
  preview: false,
  sfxBaseUrl: `${base}/sfx`,
};

let t = Date.now();
await getBundle();
console.log(`PROBE bundle: ${((Date.now() - t) / 1000).toFixed(1)}s`);
for (const gl of ["swangle", "angle"] as const) {
  t = Date.now();
  try {
    await renderVideo(props, path.join(dir, `probe-${gl}.mp4`), () => {}, { gl, frameRange: [0, 89] }).done;
    console.log(`PROBE gl=${gl}: 90 frames in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`PROBE gl=${gl}: FAILED ${(e as Error).message.split("\n")[0]}`);
  }
}
server.close();
process.exit(0);
