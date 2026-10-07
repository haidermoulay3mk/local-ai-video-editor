// Gate for the two newer Night Shift modes, through the same HTTP API the UI uses (real Claude, real renders):
//   1. "clips": a ~2.5 min talk → Claude scouts the best moments → each becomes its own short with music + hooks
//   2. "longform": a script only (no footage) → AI voiceover + visuals + music + captions
// Usage (server running): bun scripts/night-modes-test.ts [--model sonnet] [--only clips|longform] [--count 3]
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath, ffprobePath, PORT } from "../src/server/config";
import type { NightBatch } from "../src/server/night";
import type { Project } from "../src/server/store";

const API = `http://127.0.0.1:${PORT}/api`;
const H = { "x-video-editor": "1", "content-type": "application/json" };
const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d);
const model = arg("--model", "sonnet");
const only = arg("--only", "");
const count = Number(arg("--count", "3"));
const dir = path.join(APP_HOME, "test", "night");
mkdirSync(dir, { recursive: true });

// An original talk with distinct, self-contained ideas (so there are real "moments" to find).
const TALK = [
  "Here is the biggest mistake students make before exams. They reread their notes and feel productive. But rereading is the weakest way to learn.",
  "Instead, close the book and write down everything you remember. It feels harder, and that difficulty is exactly what makes it stick.",
  "Second idea. Your phone is not a tool when you study, it is a slot machine. Put it in another room, not face down on the desk. Out of sight really is out of mind.",
  "Third. Sleep is not lost study time. Your brain files the day's learning while you sleep, so pulling an all nighter literally deletes the work you just did.",
  "Here is a weird one that works. Teach the topic to an empty chair, out loud. The moment you get stuck explaining something, you have found the exact gap in your understanding.",
  "And finally, the one nobody wants to hear. Start before you feel ready. Motivation shows up after you begin, almost never before. Five minutes is enough to get going.",
];
const SCRIPT = [
  "Most people think editing a video takes hours. Tonight, it took zero minutes of my time.",
  "I gave my laptop a script before bed. It wrote the voiceover, picked the music, designed the graphics and cut everything on the beat.",
  "Here is how it works. A local AI voice reads the script. The editor finds the beat of an original track and lines up every cut. Claude checks its own work by looking at the frames.",
  "And the best part? It all runs on my own computer, for free. Follow for part two, where it edits a full YouTube video by itself.",
].join("\n\n");

function run(cmd: string[]) {
  const r = Bun.spawnSync(cmd);
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr.toString().slice(0, 500)}`);
}

async function makeTalk(): Promise<string> {
  const video = path.join(dir, "long-talk.mp4");
  if (existsSync(video)) return video;
  const face = path.join(APP_HOME, "test", "astronaut.png");
  if (!existsSync(face)) await Bun.write(face, await fetch("https://raw.githubusercontent.com/scikit-image/scikit-image/v0.19.3/skimage/data/astronaut.png"));
  const wav = path.join(dir, "long-talk.wav");
  const ps1 = path.join(dir, "tts-long.ps1");
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">${TALK.join('<break time="1400ms"/>')}</speak>`;
  writeFileSync(ps1, ["Add-Type -AssemblyName System.Speech", "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer", `$s.SetOutputToWaveFile('${wav}')`, `$s.SpeakSsml('${ssml.replace(/'/g, "''")}')`, "$s.Dispose()"].join("\n"));
  run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]);
  const dur = Number(Bun.spawnSync([ffprobePath(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).stdout.toString().trim());
  run([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-filter_threads", "1",
    "-f", "lavfi", "-i", `color=c=0x2b3340:s=1920x1080:r=30:d=${dur.toFixed(2)}`, "-loop", "1", "-framerate", "30", "-t", dur.toFixed(2), "-i", face, "-i", wav,
    "-filter_complex", "[1]scale=640:640,format=yuv420p[f];[0][f]overlay=x='640+420*sin(t/2.5)':y=220:shortest=1[v]",
    "-map", "[v]", "-map", "2:a", "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", `${video}.tmp.mp4`]);
  renameSync(`${video}.tmp.mp4`, video);
  return video;
}

const j = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${API}${url}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`${method} ${url}: ${out.error ?? r.status}`);
  return out;
};

async function shift(name: string, settings: Record<string, unknown>, files: string[]): Promise<NightBatch> {
  let b = await j<NightBatch>("POST", "/night");
  b = await j<NightBatch>("PATCH", `/night/${b.id}`, { name, settings: { model, hooks: 3, keepAwake: true, ...settings } });
  for (const f of files) {
    const r = await fetch(`${API}/night/${b.id}/files?name=${encodeURIComponent(path.basename(f))}`, { method: "POST", headers: { "x-video-editor": "1" }, body: Bun.file(f) });
    if (!r.ok) throw new Error(`upload failed: ${await r.text()}`);
  }
  return j<NightBatch>("POST", `/night/${b.id}/start`, {});
}

let ok = true;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) ok = false;
};

async function follow(b: NightBatch, t0: number): Promise<NightBatch> {
  let last = "";
  while (!["done", "cancelled"].includes(b.state)) {
    await Bun.sleep(8000);
    b = await j<NightBatch>("GET", `/night/${b.id}`);
    const line = `${b.name}: ${b.state} | ${b.items.map((i) => `${i.name.slice(0, 28)}: ${i.state}${i.step ? ` (${i.step})` : ""}`).join(" | ")}`;
    if (line !== last) console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`);
    last = line;
  }
  return b;
}

async function videoChecks(it: NightBatch["items"][number], expectVoice: boolean) {
  const p = await j<Project>("GET", `/projects/${it.projectId}`);
  const exp = p.exports.find((e) => e.label === "night");
  const lib = p.spec.audio.music.filter((m) => p.media.find((x) => x.id === m.mediaId)?.libraryTrackId);
  check(!!exp && exp.size > 50_000, `${it.name}: export ${exp?.file} ${exp?.duration.toFixed(1)} s, ${p.spec.format.width}x${p.spec.format.height}`);
  check(lib.length > 0, `${it.name}: music from the library (${lib.map((m) => `${p.media.find((x) => x.id === m.mediaId)?.name} vol ${m.volume}, offset ${m.offset}s${m.guide ? " GUIDE" : ""}`).join("; ") || "none"})`);
  check(p.spec.captions.enabled, `${it.name}: captions ${p.spec.captions.enabled ? p.spec.captions.style : "off"}, ${p.spec.overlays.length} overlays, ${p.spec.effects.length} effects, ${p.spec.audio.sfx.length} sfx`);
  if (expectVoice) check(p.spec.audio.voice.length > 0, `${it.name}: ${p.spec.audio.voice.length} voiceover track(s)`);
  check((p.hooks?.length ?? 0) >= 2 && (p.hooks ?? []).every((h) => h.previewState === "done"), `${it.name}: ${p.hooks?.length ?? 0} hooks with previews (${(p.hooks ?? []).map((h) => `${h.pattern} ${h.score}`).join(", ")})`);
  console.log(`        Claude: ${(p.night?.summary ?? "").slice(0, 260).replace(/\n/g, " ")}`);
}

const t0 = Date.now();
if (!only || only === "clips") {
  const talk = await makeTalk();
  let b = await shift("Gate: long video → shorts", { mode: "clips", clipCount: count, format: "auto" }, [talk]);
  console.log(`clips shift ${b.id} started (model ${model}, ${count} clips)`);
  b = await follow(b, t0);
  const scout = b.items.find((i) => i.kind === "scout");
  const clips = b.items.filter((i) => i.kind === "clip");
  check(b.state === "done", `clips shift finished in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  check(scout?.state === "done", `scout: ${scout?.step ?? scout?.error}`);
  check(clips.length >= Math.min(2, count), `${clips.length} clips found: ${clips.map((c) => `"${c.name}" ${c.clip?.in.toFixed(0)}-${c.clip?.out.toFixed(0)}s (score ${c.clip?.score})`).join("; ")}`);
  for (const c of clips) {
    check(c.state === "done", `${c.name}: ${c.state}${c.error ? ` — ${c.error}` : ""} (edit by ${c.edit})`);
    if (c.projectId && c.state === "done") await videoChecks(c, false);
  }
  const tracks = new Set<string>();
  for (const c of clips.filter((x) => x.projectId)) {
    const p = await j<Project>("GET", `/projects/${c.projectId}`);
    for (const m of p.spec.audio.music) {
      const id = p.media.find((x) => x.id === m.mediaId)?.libraryTrackId;
      if (id) tracks.add(id);
    }
  }
  if (clips.length >= 2) check(tracks.size >= 2, `music varies across the shorts (${tracks.size} different tracks for ${clips.length} shorts)`);
}
if (!only || only === "longform") {
  const t1 = Date.now();
  let b = await shift("Gate: long-form from a script", { mode: "longform", script: SCRIPT, voice: "am_michael", format: "auto" }, []);
  console.log(`long-form shift ${b.id} started (model ${model}, script only)`);
  b = await follow(b, t1);
  const it = b.items[0];
  check(b.state === "done" && it?.state === "done", `long-form shift finished in ${((Date.now() - t1) / 60000).toFixed(1)} min${it?.error ? ` — ${it.error}` : ""}`);
  if (it?.projectId && it.state === "done") await videoChecks(it, true);
}
console.log(ok ? "\nNIGHT MODES GATE: PASS" : "\nNIGHT MODES GATE: FAIL");
process.exit(ok ? 0 : 1);
