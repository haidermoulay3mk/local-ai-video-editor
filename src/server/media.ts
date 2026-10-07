// ffprobe / ffmpeg helpers for ingest and for Claude's frame-viewing tools. All async (never block the server).
import { mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpegPath, ffprobePath } from "./config";

export type RunResult = { code: number; stdout: string; stderr: string };

export async function run(cmd: string[], onStderr?: (chunk: string) => void, onStdout?: (chunk: string) => void, cwd?: string): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", windowsHide: true, cwd });
  const read = async (stream: ReadableStream<Uint8Array>, cb?: (s: string) => void) => {
    let all = "";
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const s = dec.decode(chunk, { stream: true });
      all += s;
      cb?.(s);
    }
    return all;
  };
  const [stdout, stderr] = await Promise.all([read(proc.stdout, onStdout), read(proc.stderr, onStderr)]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function ffmpeg(args: string[], duration?: number, onProgress?: (p: number) => void) {
  const progressArgs = onProgress && duration ? ["-progress", "pipe:1", "-nostats"] : [];
  const res = await run(
    [ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", ...progressArgs, ...args],
    undefined,
    (chunk) => {
      if (!onProgress || !duration) return;
      const m = /out_time_us=(\d+)/.exec(chunk) ?? /out_time_ms=(\d+)/.exec(chunk);
      if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
    },
  );
  if (res.code !== 0) throw new Error(`ffmpeg failed: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return res;
}

export type Probe = {
  kind: "video" | "audio" | "image";
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  rotation: number;
  vcodec?: string;
};

type FFStream = {
  codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string;
  disposition?: { attached_pic?: number }; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[];
};

const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "gif", "tiff"]);

export async function probe(file: string): Promise<Probe> {
  const res = await run([ffprobePath(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  if (res.code !== 0) throw new Error(`Not a readable media file (${res.stderr.trim().slice(0, 200)})`);
  const j = JSON.parse(res.stdout) as { streams: FFStream[]; format: { duration?: string; format_name?: string } };
  const v = j.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = j.streams.find((s) => s.codec_type === "audio");
  const duration = Number(j.format.duration ?? 0) || 0;
  const rate = (r?: string) => {
    const [n, d] = (r ?? "0/1").split("/").map(Number);
    return d ? n! / d : 0;
  };
  if (!v && !a) throw new Error("No audio or video stream found");
  const rotation = Number(v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0) || 0;
  let width = v?.width ?? 0, height = v?.height ?? 0;
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const isImage = !!v && IMAGE_CODECS.has(v.codec_name) && (!duration || duration < 0.2 || /image2|_pipe/.test(j.format.format_name ?? ""));
  return {
    kind: !v ? "audio" : isImage ? "image" : "video",
    duration: isImage ? 0 : duration,
    width,
    height,
    fps: v ? Math.round((rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30) * 1000) / 1000 : 0,
    hasAudio: !!a,
    rotation,
    vcodec: v?.codec_name,
  };
}

const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));

/** Light H.264 copy for smooth browser preview (720p short side, keyframe every 1s for fast seeking). */
export async function makeProxy(src: string, dst: string, p: Probe, onProgress?: (x: number) => void) {
  const short = Math.min(p.width, p.height);
  const scale = short <= 720 ? "scale=trunc(iw/2)*2:trunc(ih/2)*2" : p.width >= p.height ? "scale=-2:720" : "scale=720:-2";
  const audio = p.hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2"] : ["-an"];
  await ffmpeg(
    ["-i", src, "-vf", `${scale},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
      "-g", String(Math.max(1, Math.round(p.fps || 30))), "-threads", threads, ...audio, "-movflags", "+faststart", dst],
    p.duration,
    onProgress,
  );
}

/** Full-quality normalised copy, only when the original would trip up the renderer (rotation, exotic codec). */
export function needsMaster(p: Probe): boolean {
  return p.kind === "video" && (p.rotation !== 0 || !["h264", "hevc", "vp9", "av1", "prores", "vp8"].includes(p.vcodec ?? ""));
}

export async function makeMaster(src: string, dst: string, p: Probe, onProgress?: (x: number) => void) {
  const audio = p.hasAudio ? ["-c:a", "aac", "-b:a", "256k"] : ["-an"];
  await ffmpeg(
    ["-i", src, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "fast", "-crf", "16",
      "-threads", threads, ...audio, "-movflags", "+faststart", dst],
    p.duration,
    onProgress,
  );
}

export async function extractAudio16k(src: string, dst: string) {
  await ffmpeg(["-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst]);
}

/**
 * "Creator voice" chain: rumble cut, denoise, de-mud, presence lift, de-ess, gentle compression, then
 * broadcast loudness (-16 LUFS; the final mix is mastered again at export). Audio-only m4a.
 */
export const VOICE_CHAIN = [
  "highpass=f=80", "lowpass=f=15000", "afftdn=nf=-25:tn=1",
  "equalizer=f=250:t=q:w=1.1:g=-2.5", "equalizer=f=3800:t=q:w=1.3:g=2.5", "deesser=i=0.35",
  "acompressor=threshold=-21dB:ratio=3:attack=8:release=120:makeup=2", "loudnorm=I=-16:TP=-1.5:LRA=11",
].join(",");

export async function enhanceVoice(src: string, dst: string, duration: number, onProgress?: (x: number) => void) {
  await ffmpeg(["-i", src, "-vn", "-af", VOICE_CHAIN, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", dst], duration, onProgress);
}

export type Loudness = { I: number; TP: number; LRA: number; thresh: number; offset: number };

/** Integrated loudness of a file's audio (EBU R128 via loudnorm's analysis pass), or null if it has no sound. */
export async function measureLoudness(file: string, target = -14): Promise<Loudness | null> {
  const res = await run([ffmpegPath(), "-hide_banner", "-nostats", "-i", file, "-vn", "-af", `loudnorm=I=${target}:TP=-1:LRA=11:print_format=json`, "-f", "null", "-"]);
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(res.stderr)?.[0];
  if (!json) return null;
  const j = JSON.parse(json) as Record<string, string>;
  const n = (k: string) => Number(j[k]);
  if (!Number.isFinite(n("input_i")) || n("input_i") < -70) return null; // silent
  return { I: n("input_i"), TP: n("input_tp"), LRA: n("input_lra"), thresh: n("input_thresh"), offset: n("target_offset") };
}

/**
 * Master an export's final mix to the level every platform normalises to (-14 LUFS integrated,
 * -1 dBTP), two-pass so it's exact and unpumped. The video stream is copied untouched.
 */
export async function masterAudio(file: string, target = -14): Promise<{ before: number; after: number } | null> {
  const m = await measureLoudness(file, target);
  if (!m) return null;
  const tmp = `${file}.master.mp4`;
  const af = `loudnorm=I=${target}:TP=-1:LRA=11:measured_I=${m.I}:measured_TP=${m.TP}:measured_LRA=${m.LRA}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true,aresample=48000`;
  await ffmpeg(["-i", file, "-map", "0:v?", "-map", "0:a:0", "-c:v", "copy", "-af", af, "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", tmp]);
  renameSync(tmp, file);
  const after = await measureLoudness(file, target);
  return { before: Math.round(m.I * 10) / 10, after: Math.round((after?.I ?? target) * 10) / 10 };
}

export async function detectSilences(wav: string, noiseDb = -35, minDur = 0.35): Promise<{ start: number; end: number }[]> {
  const res = await run([ffmpegPath(), "-hide_banner", "-nostats", "-i", wav, "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`, "-f", "null", "-"]);
  const out: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (const line of res.stderr.split(/\r?\n/)) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  return out;
}

/** Grab single frames (JPEG) at the given source times. */
export async function grabFrames(src: string, times: number[], outDir: string, width = 384): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (const t of times) {
    const f = path.join(outDir, `src-${Math.round(t * 1000)}-${width}.jpg`);
    await ffmpeg(["-ss", t.toFixed(3), "-i", src, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", f]);
    files.push(f);
  }
  return files;
}
