// Voiceover worker (runs under Node, one process per job, like the render worker).
// Kokoro-82M (Apache-2.0) runs fully on this PC; the model (~90 MB) downloads once from Hugging Face.
// If Kokoro can't load, Windows' built-in voice is used instead so a voiceover is never missing.
// Protocol: argv[2] = job JSON file; prints "@@{json}" lines: {event:"done", result} | {event:"error", message}.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TOOLS } from "./config";

type Job = { text: string; voice: string; speed: number; outFile: string };
const out = (msg: unknown) => process.stdout.write(`@@${JSON.stringify(msg)}\n`);

/** Sentences (≤ ~350 chars each) so every Kokoro call stays well inside its token window. */
export function splitForSpeech(text: string): { text: string; pause: number }[] {
  const parts: { text: string; pause: number }[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const sentences = para.replace(/\s+/g, " ").trim().match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? [];
    for (const raw of sentences) {
      let s = raw.trim();
      while (s.length > 350) {
        const cut = Math.max(s.lastIndexOf(",", 350), s.lastIndexOf(" ", 350));
        parts.push({ text: s.slice(0, cut > 100 ? cut + 1 : 350).trim(), pause: 0.12 });
        s = s.slice(cut > 100 ? cut + 1 : 350).trim();
      }
      if (s) parts.push({ text: s, pause: 0.22 });
    }
    if (parts.length) parts[parts.length - 1]!.pause = 0.45; // breath between paragraphs
  }
  return parts;
}

function wav(samples: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return b;
}

async function kokoro(job: Job): Promise<{ duration: number }> {
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(TOOLS.models, "kokoro");
  const { KokoroTTS } = await import("kokoro-js");
  const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
  const chunks: Float32Array[] = [];
  let rate = 24000;
  for (const part of splitForSpeech(job.text)) {
    const audio = await tts.generate(part.text, { voice: job.voice as never, speed: job.speed });
    rate = audio.sampling_rate;
    chunks.push(audio.audio, new Float32Array(Math.round(part.pause * rate)));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  writeFileSync(job.outFile, wav(all, rate));
  return { duration: total / rate };
}

function windowsVoice(job: Job): { duration: number } {
  const ps1 = `${job.outFile}.ps1`;
  const txt = `${job.outFile}.txt`;
  writeFileSync(txt, job.text, "utf8");
  writeFileSync(ps1, [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$s.Rate = ${Math.round((job.speed - 1) * 5)}`,
    `$s.SetOutputToWaveFile('${job.outFile.replace(/'/g, "''")}')`,
    `$s.Speak([System.IO.File]::ReadAllText('${txt.replace(/'/g, "''")}'))`,
    "$s.Dispose()",
  ].join("\n"));
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Windows voice failed: ${r.stderr.slice(0, 300)}`);
  const head = readFileSync(job.outFile);
  const byteRate = head.readUInt32LE(28);
  return { duration: (head.length - 44) / byteRate };
}

async function main() {
  const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Job;
  mkdirSync(path.dirname(job.outFile), { recursive: true });
  try {
    const r = await kokoro(job);
    out({ event: "done", result: { file: job.outFile, duration: r.duration, engine: "kokoro" } });
  } catch (err) {
    process.stderr.write(`kokoro failed, using the Windows voice: ${(err as Error).message}\n`);
    const r = windowsVoice(job);
    out({ event: "done", result: { file: job.outFile, duration: r.duration, engine: "windows" } });
  }
}

if (process.argv[2]) {
  main().catch((err) => {
    out({ event: "error", message: (err as Error).message });
    process.exit(1);
  });
}
