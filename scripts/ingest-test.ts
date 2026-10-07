// Phase 2 gate: synthetic talking-head video -> full ingest -> check transcript, silences, faces.
// Usage: bun scripts/ingest-test.ts
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath } from "../src/server/config";
import { enqueueIngest, ingestQueueLength } from "../src/server/ingest";
import { createProject, getAnalysis, getProject, mediaDir, newId, now, saveProject } from "../src/server/store";

const dir = path.join(APP_HOME, "test");
mkdirSync(dir, { recursive: true });
const SCRIPT = [
  "Hey, I am Sam, testing my video editor.",
  "This video editor runs fully on my own laptop.",
  "It finds silences, writes captions, and tracks my face. Let us see if it works.",
];

// 1. Public-domain NASA portrait (scikit-image's standard "astronaut" test image).
const face = path.join(dir, "astronaut.png");
if (!existsSync(face)) {
  const res = await fetch("https://raw.githubusercontent.com/scikit-image/scikit-image/v0.19.3/skimage/data/astronaut.png");
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  await Bun.write(face, res);
}

// 2. Speech via Windows' built-in synthesizer, with 1.5 s pauses between sentences.
const wav = path.join(dir, "tts.wav");
if (!existsSync(wav)) {
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">${SCRIPT.join('<break time="1500ms"/>')}</speak>`;
  const ps1 = path.join(dir, "tts.ps1");
  writeFileSync(ps1, [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$s.SetOutputToWaveFile('${wav}')`,
    `$s.SpeakSsml('${ssml}')`,
    "$s.Dispose()",
  ].join("\n"));
  const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

// 3. 16:9 video: the face drifts left/right so tracking and vertical reframing have something to follow.
const video = path.join(dir, "talking.mp4");
if (!existsSync(video)) {
  const r = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x2b3340:s=1920x1080:r=30",
    "-loop", "1", "-i", face, "-i", wav,
    "-filter_complex", "[1]scale=640:640[f];[0][f]overlay=x='640+420*sin(t/2.5)':y=220:shortest=1[v]",
    "-map", "[v]", "-map", "2:a", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

// 4. Real ingest through the project store.
const p = createProject("Ingest gate test", "short");
const mid = newId();
mkdirSync(mediaDir(p.id, mid), { recursive: true });
copyFileSync(video, path.join(mediaDir(p.id, mid), "original.mp4"));
p.media.push({
  id: mid, kind: "video", name: "talking.mp4", original: "original.mp4", width: 0, height: 0, duration: 0, fps: 0,
  hasAudio: false, size: 0, addedAt: now(), source: { type: "upload" }, steps: {},
});
saveProject(p);
const t0 = Date.now();
enqueueIngest(p.id, mid);
while (ingestQueueLength() > 0) await Bun.sleep(500);
console.log(`ingest finished in ${((Date.now() - t0) / 1000).toFixed(1)}s (project ${p.id})`);

const m = getProject(p.id)!.media[0]!;
console.log("steps:", Object.entries(m.steps).map(([k, v]) => `${k}=${v?.state}${v?.error ? `(${v.error})` : ""}`).join(" "));
console.log(`probe: ${m.kind} ${m.width}x${m.height} ${m.duration.toFixed(2)}s fps=${m.fps} audio=${m.hasAudio}`);
const a = getAnalysis(p.id, mid);
const heard = (a.words ?? []).map((w) => w.text).join(" ");
console.log(`language: ${a.language}\ntranscript: ${heard}`);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/).filter(Boolean);
const expected = norm(SCRIPT.join(" "));
const got = new Set(norm(heard));
const hit = expected.filter((w) => got.has(w)).length;
console.log(`word recall: ${hit}/${expected.length} = ${((100 * hit) / expected.length).toFixed(0)}%`);
console.log("first words:", (a.words ?? []).slice(0, 6).map((w) => `${w.text}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(" "));
console.log("silences:", (a.silences ?? []).map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join(", "));
const samples = a.faces?.samples ?? [];
const found = samples.filter(Boolean) as number[][];
console.log(`faces: ${found.length}/${samples.length} samples with a face`);
if (found.length) {
  const xs = found.map((s) => s[0]!);
  console.log(`face cx range ${Math.min(...xs).toFixed(3)}..${Math.max(...xs).toFixed(3)}; first sample ${JSON.stringify(found[0]!.map((v) => +v.toFixed(3)))}`);
}
process.exit(0);
