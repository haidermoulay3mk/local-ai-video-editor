// End-to-end gate (server running): upload a shaky/dark clip → picture verdict → Fix footage → export
// → the export uses the fixed picture and is loudness-mastered. Usage: bun scripts/fix-e2e.ts
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath, PORT } from "../src/server/config";
import { analyzeLook } from "../src/server/look";
import { measureLoudness } from "../src/server/media";
import type { Project } from "../src/server/store";

const API = `http://127.0.0.1:${PORT}/api`;
const H = { "x-video-editor": "1", "content-type": "application/json" };
const dir = path.join(APP_HOME, "test", "quality");
mkdirSync(dir, { recursive: true });
let ok = true;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) ok = false;
};
const j = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${API}${url}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`${method} ${url}: ${out.error ?? r.status}`);
  return out;
};
const waitFor = async (pid: string, cond: (p: Project) => boolean, ms: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = await j<Project>("GET", `/projects/${pid}`);
    if (cond(p)) return p;
    await Bun.sleep(1500);
  }
  throw new Error("timed out");
};

// A shaky, dark clip WITH quiet sound (so the export has audio to master).
const clip = path.join(dir, "shaky-dark-audio.mp4");
if (!existsSync(clip)) {
  const face = path.join(APP_HOME, "test", "astronaut.png");
  const r = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", face, "-f", "lavfi", "-i", "sine=f=220:d=8:sample_rate=48000",
    "-t", "8", "-r", "30", "-vf", "scale=1200:1200,crop=1080:1080:x='60+22*sin(n*2.3)+14*sin(n*5.1)':y='60+20*cos(n*1.9)+12*sin(n*4.3)',scale=720:720,eq=brightness=-0.2:contrast=0.85,format=yuv420p",
    "-af", "volume=0.08", "-shortest", "-c:v", "libx264", "-crf", "18", "-c:a", "aac", clip]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

const p0 = await j<Project>("POST", "/projects", { name: "Fix e2e", platform: "square" });
try {
  const up = await fetch(`${API}/projects/${p0.id}/media?name=shaky-dark.mp4`, { method: "POST", headers: { "x-video-editor": "1" }, body: Bun.file(clip) });
  const m = (await up.json()) as { id: string };
  let p = await waitFor(p0.id, (x) => ["done", "error", "skipped"].includes(x.media[0]?.steps.look?.state ?? ""), 180_000);
  let media = p.media[0]!;
  console.log("verdict:", JSON.stringify(media.lookSummary), "steps:", Object.entries(media.steps).map(([k, v]) => `${k}:${v?.state}`).join(" "));
  check(media.steps.look?.state === "done", "ingest ran the new 'Checking picture' step");
  check(!!media.lookSummary?.fixable && media.lookSummary.notes.some((n) => n.startsWith("shaky")) && media.lookSummary.notes.some((n) => n.startsWith("dark")),
    `verdict shown to the user: ${media.lookSummary?.notes.join(" · ")}`);

  await j("POST", `/projects/${p0.id}/media/${m.id}/fix`, {});
  p = await waitFor(p0.id, (x) => !!x.media[0]?.fixed && x.media[0]?.steps.look?.state === "done" && x.media[0]?.steps.faces?.state !== "running", 300_000);
  media = p.media[0]!;
  check(media.render === "fixed.mp4" && !!media.fixed?.stabilize, `"Fix footage" made fixed.mp4 the render source (${JSON.stringify(media.fixed)})`);
  const props = await j<{ media: Record<string, { src: string }> }>("GET", `/projects/${p0.id}/props`);
  const served = await fetch(`http://127.0.0.1:${PORT}${props.media[m.id]!.src.replace(/^https?:\/\/[^/]+/, "")}`, { method: "HEAD" });
  check(/fixed\.mp4/.test(props.media[m.id]!.src) && served.ok, `render props point at the fixed file and the server serves it (HTTP ${served.status})`);
  const after = await analyzeLook(path.join(APP_HOME, "data", "projects", p0.id, "media", m.id, "fixed.mp4"), dir);
  check((after.shake ?? 9) < 0.35, `fixed footage is steady (${after.shake}% jitter)`);

  // A one-clip edit, exported for real.
  const spec = (await j<Project>("GET", `/projects/${p0.id}`)).spec;
  await j("PUT", `/projects/${p0.id}/spec`, { spec: { ...spec, clips: [{ id: "c1", mediaId: m.id, in: 0, out: 7.5 }] }, reason: "e2e" });
  await j("POST", `/projects/${p0.id}/render`, { quality: "draft" });
  p = await waitFor(p0.id, (x) => x.exports.length > 0, 600_000);
  const file = path.join(APP_HOME, "data", "projects", p0.id, "exports", p.exports[0]!.file);
  const loud = await measureLoudness(file);
  check(!!loud && Math.abs(loud.I + 14) <= 1, `export is loudness-mastered: ${loud?.I.toFixed(1)} LUFS (the source was about -30)`);

  await j("POST", `/projects/${p0.id}/media/${m.id}/unfix`, {});
  p = await waitFor(p0.id, (x) => !x.media[0]?.fixed && x.media[0]?.steps.look?.state === "done" && x.media[0]?.steps.faces?.state === "done", 300_000);
  check(!p.media[0]!.render && !p.media[0]!.fixed, "Undo fix goes back to the original footage");
} finally {
  await fetch(`${API}/projects/${p0.id}`, { method: "DELETE", headers: H });
}
console.log(ok ? "\nFIX E2E: PASS" : "\nFIX E2E: FAIL");
process.exit(ok ? 0 : 1);
