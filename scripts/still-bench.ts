// Diagnostic: time single-frame renders per layer type to find what is slow.
// Usage: node --import tsx scripts/still-bench.ts [gl]
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { APP_HOME } from "../src/server/config";
import { getBundle } from "../src/server/render";
import { type CompositionProps, parseSpec, type SpecInput } from "../src/shared/spec";

const gl = (process.argv[2] ?? "swangle") as "swangle" | "angle";
const engine = (process.argv[3] ?? "offthread") as "offthread" | "webcodecs";
const dir = path.join(APP_HOME, "test");
const server = http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent((req.url ?? "/").slice(1).split("?")[0]!));
  if (!file.startsWith(dir) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "Content-Length": statSync(file).size, "Access-Control-Allow-Origin": "*" });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const media: CompositionProps["media"] = {
  A: { id: "A", kind: "video", name: "a", src: `${base}/a.mp4`, width: 1920, height: 1080, duration: 8, fps: 30, hasAudio: true },
};
const clipA = { clips: [{ id: "c1", mediaId: "A", in: 0, out: 6 }] };
const scenarios: Record<string, SpecInput> = {
  empty: { overlays: [{ type: "text", id: "t", start: 0, end: 6, text: "x" }] },
  titleCard: { overlays: [{ type: "template", id: "t", start: 0, end: 6, template: "titleCard", props: { title: "Hello" } }] },
  video: clipA,
  videoGrade: { ...clipA, grade: { preset: "cinematic" } },
  videoGrain: { ...clipA, grade: { grain: 0.5 } },
  videoBlurFit: { ...clipA, reframe: { mode: "blur" } },
};

const serveUrl = await getBundle();
const browser = await openBrowser("chrome", { chromiumOptions: { gl } });
for (const [name, s] of Object.entries(scenarios)) {
  const spec = parseSpec({ format: { preset: "short", width: 1080, height: 1920, fps: 30 }, ...s });
  const inputProps = { spec, media, analysis: {}, preview: false, sfxBaseUrl: base, videoEngine: engine } as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: "Main", inputProps, puppeteerInstance: browser });
  const times: number[] = [];
  for (const frame of [10, 40, 70]) {
    const t = Date.now();
    await renderStill({ composition, serveUrl, frame, inputProps, output: path.join(dir, `bench-${name}.jpg`), imageFormat: "jpeg", puppeteerInstance: browser, overwrite: true });
    times.push(Date.now() - t);
  }
  console.log(`STILL gl=${gl} engine=${engine} ${name.padEnd(12)} ${times.map((x) => `${x}ms`).join("  ")}`);
}
await browser.close({ silent: true });
server.close();
process.exit(0);
