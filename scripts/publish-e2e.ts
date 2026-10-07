// End-to-end gate (server running): a talking clip with real speech → transcript → subtitle files (SRT / VTT),
// upload text + chapter rules, thumbnails, and an export with its .srt beside it. Usage: bun scripts/publish-e2e.ts
// (KEEP=1 keeps the test project so you can open it in the UI).
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath, PORT } from "../src/server/config";
import type { Project } from "../src/server/store";
import { DEFAULT_VOICE, synthesizeVoice } from "../src/server/tts";

const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api`;
const H = { "x-video-editor": "1", "content-type": "application/json" };
const dir = path.join(APP_HOME, "test", "publish");
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
    await Bun.sleep(2000);
  }
  throw new Error("timed out");
};
const ff = (args: string[]) => {
  const r = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

// A vertical "talking" clip: a public-domain portrait (NASA astronaut photo) + a real AI voice line.
const clip = path.join(dir, "talking.mp4");
if (!existsSync(clip)) {
  const face = path.join(APP_HOME, "test", "astronaut.png");
  if (!existsSync(face)) await Bun.write(face, await (await fetch("https://raw.githubusercontent.com/scikit-image/scikit-image/v0.19.3/skimage/data/astronaut.png")).arrayBuffer());
  const wav = path.join(dir, "voice.wav");
  await synthesizeVoice("Here are three things nobody tells you about editing. First, cut every pause. Second, captions matter more than music. Third, end on your strongest line.", DEFAULT_VOICE, 1, wav);
  ff(["-loop", "1", "-i", face, "-i", wav, "-vf", "scale=720:-2,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x1c1c22,format=yuv420p", "-r", "30", "-shortest", "-c:v", "libx264", "-crf", "20", "-c:a", "aac", clip]);
}

const p0 = await j<Project>("POST", "/projects", { name: "Publish e2e", platform: "short" });
try {
  const up = await fetch(`${API}/projects/${p0.id}/media?name=talking.mp4`, { method: "POST", headers: { "x-video-editor": "1" }, body: Bun.file(clip) });
  const m = (await up.json()) as { id: string };
  let p = await waitFor(p0.id, (x) => ["done", "error", "skipped"].includes(x.media[0]?.steps.look?.state ?? ""), 300_000);
  const media = p.media[0]!;
  check(media.steps.transcript?.state === "done", `transcribed (${media.duration.toFixed(1)} s clip)`);

  const spec = { ...p.spec, clips: [{ id: "c1", mediaId: m.id, in: 0, out: Math.floor(media.duration * 10) / 10 }], captions: { ...p.spec.captions, enabled: true, style: "bold" } };
  const r = await j<{ ok: boolean; errors: string[] }>("PUT", `/projects/${p0.id}/spec`, { spec, reason: "publish gate" });
  check(r.ok, `edit applied ${r.errors.join("; ")}`);

  const srt = await (await fetch(`${API}/projects/${p0.id}/subtitles?format=srt`)).text();
  const vtt = await (await fetch(`${API}/projects/${p0.id}/subtitles?format=vtt`)).text();
  check(/^1\r?\n00:00:0\d,\d{3} --> 00:00:\d\d,\d{3}\r?\n\S/.test(srt), `SRT is well-formed (${srt.split(/\n\n/).length} cues)`);
  check(/pause/i.test(srt) && /strongest/i.test(srt), "SRT contains the spoken words");
  check(vtt.startsWith("WEBVTT") && /00:00:0\d\.\d{3} --> /.test(vtt), "VTT is well-formed");

  const bad = await j<{ ok: boolean; warnings: string[] }>("PUT", `/projects/${p0.id}/publish`, { title: "x", chapters: [{ at: 5, title: "Late start" }] });
  check(bad.ok && bad.warnings.some((w) => /0:00/.test(w)), `chapter rules enforced: ${bad.warnings.join(" | ")}`);
  const pub = await j<{ ok: boolean; text: string }>("PUT", `/projects/${p0.id}/publish`, {
    title: "3 editing rules nobody tells you", description: "Cut pauses, caption everything, end strong.\nWhich one do you skip?", hashtags: ["editing", "#shorts", "contentcreator"],
  });
  const st = await j<{ text: string | null; subtitleLines: number }>("GET", `/projects/${p0.id}/publish`);
  check(pub.ok && !!st.text?.includes("#editing #shorts #contentcreator") && st.text.startsWith("Cut pauses"), "upload text stored with normalised hashtags");
  check(st.subtitleLines > 0, `publish panel sees ${st.subtitleLines} subtitle lines`);

  const th = await j<{ thumbnails: { file: string }[] }>("POST", `/projects/${p0.id}/thumbnails`, { text: "CUT EVERY PAUSE" });
  check(th.thumbnails.length === 3, `3 thumbnail options rendered (${th.thumbnails.map((t) => t.file).join(", ")})`);
  const files: string[] = [];
  for (const t of th.thumbnails) {
    const res = await fetch(`${BASE}/files/${p0.id}/thumbnails/${t.file}`);
    const buf = await res.arrayBuffer();
    const f = path.join(dir, t.file);
    await Bun.write(f, buf);
    files.push(f);
    check(res.ok && (res.headers.get("content-type") ?? "").includes("jpeg") && buf.byteLength > 20_000, `${t.file} served (${(buf.byteLength / 1024).toFixed(0)} KB)`);
  }
  ff([...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, i) => `[${i}:v]scale=360:640[s${i}]`).join(";")};${files.map((_, i) => `[s${i}]`).join("")}hstack=inputs=${files.length}`, path.join(dir, "thumb-sheet.jpg")]);

  await j("POST", `/projects/${p0.id}/render`, { quality: "draft" });
  p = await waitFor(p0.id, (x) => x.exports.length > 0, 600_000);
  const mp4 = p.exports[0]!.file;
  const srtName = mp4.replace(/\.mp4$/, ".srt");
  const res = await fetch(`${BASE}/files/${p0.id}/exports/${srtName}`);
  const body = await res.text();
  check(res.ok && /-->/.test(body), `export ${mp4} has ${srtName} beside it`);
  console.log(`thumbnails sheet: ${path.join(dir, "thumb-sheet.jpg")}`);
} catch (e) {
  check(false, (e as Error).message);
} finally {
  if (process.env.KEEP !== "1") await fetch(`${API}/projects/${p0.id}`, { method: "DELETE", headers: H });
}
console.log(ok ? "\nPUBLISH E2E: PASS" : "\nPUBLISH E2E: FAIL");
process.exit(ok ? 0 : 1);
