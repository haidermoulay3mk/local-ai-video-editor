// Night Shift gate: two synthetic talking clips -> a real night shift through the HTTP API (real Claude, real renders)
// -> checks every video got an edit, an export and hook ideas with preview renders.
// Usage: bun start (in another terminal), then: bun scripts/night-test.ts [--model haiku|sonnet|opus]
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath, ffprobePath, PORT } from "../src/server/config";
import type { NightBatch } from "../src/server/night";
import type { Project } from "../src/server/store";

const API = `http://127.0.0.1:${PORT}/api`;
const H = { "x-video-editor": "1", "content-type": "application/json" };
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "sonnet";
const dir = path.join(APP_HOME, "test", "night");
mkdirSync(dir, { recursive: true });

const CLIPS = [
  {
    file: "free-editor.mp4", size: "1920x1080", faceX: "640+420*sin(t/2.5)", faceY: "220",
    lines: [
      "Most people think you need expensive software to make good videos.",
      "You do not. I built my own video editor, and it runs on my laptop for free.",
      "It cuts the silences, writes the captions, and even follows my face.",
      "And the best part? It edits my videos while I sleep.",
    ],
  },
  {
    file: "study-tip.mp4", size: "1080x1920", faceX: "220+120*sin(t/2)", faceY: "640",
    lines: [
      "Here is one study tip that changed my grades.",
      "Stop rereading your notes.",
      "Close the book and test yourself instead. It feels harder, and that is exactly why it works.",
    ],
  },
];

function run(cmd: string[]) {
  const r = Bun.spawnSync(cmd);
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr.toString().slice(0, 600)}`);
}

// 1. Clips: Windows' built-in speech + a public-domain NASA portrait (scikit-image "astronaut").
const face = path.join(APP_HOME, "test", "astronaut.png");
if (!existsSync(face)) {
  const res = await fetch("https://raw.githubusercontent.com/scikit-image/scikit-image/v0.19.3/skimage/data/astronaut.png");
  await Bun.write(face, res);
}
for (const c of CLIPS) {
  const video = path.join(dir, c.file);
  if (existsSync(video)) continue;
  const wav = path.join(dir, `${c.file}.wav`);
  const ps1 = path.join(dir, "tts.ps1");
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">${c.lines.join('<break time="1200ms"/>')}</speak>`;
  writeFileSync(ps1, [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$s.SetOutputToWaveFile('${wav}')`,
    `$s.SpeakSsml('${ssml}')`,
    "$s.Dispose()",
  ].join("\n"));
  run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]);
  // Bounded inputs + few threads: keeps ffmpeg's memory small on a busy PC.
  const dur = Number(Bun.spawnSync([ffprobePath(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).stdout.toString().trim());
  run([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-filter_threads", "1",
    "-f", "lavfi", "-i", `color=c=0x2b3340:s=${c.size}:r=30:d=${dur.toFixed(2)}`, "-loop", "1", "-framerate", "30", "-t", dur.toFixed(2), "-i", face, "-i", wav,
    "-filter_complex", `[1]scale=640:640,format=yuv420p[f];[0][f]overlay=x='${c.faceX}':y=${c.faceY}:shortest=1[v]`,
    "-map", "[v]", "-map", "2:a", "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", `${video}.tmp.mp4`]);
  renameSync(`${video}.tmp.mp4`, video); // only a complete clip is ever reused
}

// 2. A night shift through the same API the UI uses.
const j = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${API}${url}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`${method} ${url}: ${out.error ?? r.status}`);
  return out;
};
// --check <shiftId>: only run the gate checks on a shift that already finished.
const checkId = process.argv.includes("--check") ? process.argv[process.argv.indexOf("--check") + 1] : undefined;
let b: NightBatch;
if (checkId) {
  b = await j<NightBatch>("GET", `/night/${checkId}`);
} else {
  b = await j<NightBatch>("POST", "/night");
  b = await j<NightBatch>("PATCH", `/night/${b.id}`, { name: "Night Shift gate test", settings: { model, hooks: 3, keepAwake: true } });
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined; // e.g. study-tip.mp4
  for (const c of CLIPS.filter((x) => !only || x.file === only)) {
    const r = await fetch(`${API}/night/${b.id}/files?name=${encodeURIComponent(c.file)}`, {
      method: "POST", headers: { "x-video-editor": "1" }, body: Bun.file(path.join(dir, c.file)),
    });
    if (!r.ok) throw new Error(`upload failed: ${await r.text()}`);
  }
  b = await j<NightBatch>("POST", `/night/${b.id}/start`, {});
  console.log(`shift ${b.id} started with model=${model} — http://127.0.0.1:${PORT}/#/night/${b.id}`);
}
const t0 = checkId ? Date.parse(b.startedAt ?? b.createdAt) : Date.now();

// 3. Follow it until it's finished.
let last = "";
while (!["done", "cancelled"].includes(b.state)) {
  await Bun.sleep(5000);
  b = await j<NightBatch>("GET", `/night/${b.id}`);
  const line = `${b.state} | ${b.items.map((i) => `${i.name}: ${i.state}${i.step ? ` (${i.step})` : ""}`).join(" | ")}`;
  if (line !== last) console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`);
  last = line;
}

// 4. Gate checks.
let ok = true;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) ok = false;
};
check(b.state === "done", `shift finished (state=${b.state}) in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
for (const it of b.items) {
  check(it.state === "done", `${it.name}: ${it.state}${it.error ? ` — ${it.error}` : ""} (edit by ${it.edit})`);
  if (!it.projectId) continue;
  const p = await j<Project>("GET", `/projects/${it.projectId}`);
  const exp = p.exports.find((e) => e.label === "night");
  check(!!exp && exp.size > 50_000, `${it.name}: export ${exp?.file} ${(exp?.size ?? 0) / 1e6} MB, ${exp?.duration.toFixed(1)} s, ${p.spec.format.width}x${p.spec.format.height}`);
  check(p.spec.clips.length > 0 && (p.spec.captions.enabled || p.spec.overlays.length > 0), `${it.name}: ${p.spec.clips.length} clips, captions=${p.spec.captions.enabled}, ${p.spec.overlays.length} overlays, ${p.spec.effects.length} effects`);
  check((p.hooks?.length ?? 0) >= 2, `${it.name}: ${p.hooks?.length ?? 0} hook ideas`);
  for (const h of p.hooks ?? []) {
    const file = h.preview ? path.join(APP_HOME, "data", "projects", p.id, h.preview) : "";
    const size = file && existsSync(file) ? statSync(file).size : 0;
    check(h.previewState === "done" && size > 10_000, `  hook ${h.id} [${h.pattern}, ${h.score}/10] "${h.title}" — preview ${h.previewState} ${(size / 1e3).toFixed(0)} KB`);
    console.log(`        why: ${h.why}`);
  }
  const summary = p.night?.summary ?? "";
  check(summary.length > 20 && !/stopped/i.test(summary) && p.claude.status === "done", `${it.name}: morning summary from Claude (status ${p.claude.status})`);
  console.log(`        Claude: ${summary.slice(0, 300)}`);
}
console.log(ok ? "\nNIGHT SHIFT GATE: PASS" : "\nNIGHT SHIFT GATE: FAIL");
process.exit(ok ? 0 : 1);
