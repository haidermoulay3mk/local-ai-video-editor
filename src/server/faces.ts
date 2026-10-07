// Local face tracking with YuNet (ONNX, MIT licence). Nothing leaves the machine; no images are stored.
import * as ort from "onnxruntime-node";
import type { FaceTrack } from "../shared/spec";
import { ffmpegPath, TOOLS } from "./config";
import type { Probe } from "./media";

export const SAMPLE_FPS = 5;
const STRIDES = [8, 16, 32];
const SCORE_MIN = 0.6;

let session: Promise<ort.InferenceSession> | null = null;
const getSession = () => (session ??= ort.InferenceSession.create(TOOLS.faceModel, { intraOpNumThreads: 4 }));

type Det = { score: number; x: number; y: number; w: number; h: number; lm: number[] };

/** Decode YuNet outputs (same maths as OpenCV FaceDetectorYN::postProcess). Coordinates in padded-input px. */
export function decodeYuNet(out: Record<string, ort.Tensor>, padW: number, padH: number): Det[] {
  const dets: Det[] = [];
  for (const s of STRIDES) {
    const cols = Math.floor(padW / s), rows = Math.floor(padH / s);
    const cls = out[`cls_${s}`]!.data as Float32Array;
    const obj = out[`obj_${s}`]!.data as Float32Array;
    const bbox = out[`bbox_${s}`]!.data as Float32Array;
    const kps = out[`kps_${s}`]!.data as Float32Array;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(Math.min(1, Math.max(0, cls[i]!)) * Math.min(1, Math.max(0, obj[i]!)));
        if (score < SCORE_MIN) continue;
        const cx = (c + bbox[i * 4]!) * s, cy = (r + bbox[i * 4 + 1]!) * s;
        const w = Math.exp(bbox[i * 4 + 2]!) * s, h = Math.exp(bbox[i * 4 + 3]!) * s;
        const lm: number[] = [];
        for (let n = 0; n < 5; n++) lm.push((kps[i * 10 + 2 * n]! + c) * s, (kps[i * 10 + 2 * n + 1]! + r) * s);
        dets.push({ score, x: cx - w / 2, y: cy - h / 2, w, h, lm });
      }
    }
  }
  return dets;
}

/** Main subject = biggest confident face (the person talking to camera is almost always the largest). */
function pickPrimary(dets: Det[]): Det | null {
  if (!dets.length) return null;
  const best = Math.max(...dets.map((d) => d.score));
  return dets.filter((d) => d.score >= best * 0.85).sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null;
}

/** Fill short gaps (<= maxGap samples) by interpolation, then lightly smooth to remove jitter. */
export function cleanTrack(samples: (number[] | null)[], maxGap = 3, alpha = 0.6): (number[] | null)[] {
  const out = samples.map((s) => (s ? [...s] : null));
  let i = 0;
  while (i < out.length) {
    if (out[i]) { i++; continue; }
    let j = i;
    while (j < out.length && !out[j]) j++;
    const a = out[i - 1], b = out[j];
    if (a && b && j - i <= maxGap) {
      for (let k = i; k < j; k++) {
        const t = (k - i + 1) / (j - i + 1);
        out[k] = a.map((v, n) => v + (b[n]! - v) * t);
      }
    }
    i = j;
  }
  let prev: number[] | null = null;
  for (let k = 0; k < out.length; k++) {
    const cur = out[k];
    if (cur && prev) out[k] = cur.map((v, n) => alpha * v + (1 - alpha) * prev![n]!);
    prev = out[k] ?? null;
  }
  return out.map((s) => (s ? s.map((v) => Math.round(v * 10000) / 10000) : null));
}

export async function detectFaces(src: string, p: Probe, onProgress?: (x: number) => void): Promise<FaceTrack> {
  const sess = await getSession();
  const long = 480;
  const sw = p.width >= p.height ? long : Math.round((long * p.width) / p.height / 2) * 2;
  const sh = p.width >= p.height ? Math.round((long * p.height) / p.width / 2) * 2 : long;
  const pw = Math.ceil(sw / 32) * 32, ph = Math.ceil(sh / 32) * 32;
  const frameBytes = pw * ph * 3;
  const proc = Bun.spawn(
    [ffmpegPath(), "-hide_banner", "-loglevel", "error", "-i", src, "-an",
      "-vf", `fps=${SAMPLE_FPS},scale=${sw}:${sh},pad=${pw}:${ph}:0:0`, "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const expected = Math.max(1, Math.ceil(p.duration * SAMPLE_FPS));
  const samples: (number[] | null)[] = [];
  const input = new Float32Array(3 * pw * ph);
  let buf = new Uint8Array(0);

  const processFrame = async (frame: Uint8Array) => {
    const plane = pw * ph;
    for (let i = 0; i < plane; i++) {
      input[i] = frame[i * 3]!; // B
      input[plane + i] = frame[i * 3 + 1]!; // G
      input[2 * plane + i] = frame[i * 3 + 2]!; // R
    }
    const out = await sess.run({ [sess.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, ph, pw]) });
    const d = pickPrimary(decodeYuNet(out, pw, ph));
    if (!d) {
      samples.push(null);
    } else {
      const nx = (v: number) => v / sw, ny = (v: number) => v / sh;
      const l = d.lm; // right eye, left eye, nose, right mouth corner, left mouth corner
      samples.push([
        nx(d.x + d.w / 2), ny(d.y + d.h / 2), nx(d.w), ny(d.h),
        nx(l[0]!), ny(l[1]!), nx(l[2]!), ny(l[3]!), nx(l[6]!), ny(l[7]!), nx(l[8]!), ny(l[9]!),
      ]);
    }
    if (samples.length % 10 === 0) onProgress?.(Math.min(1, samples.length / expected));
  };

  for await (const chunk of proc.stdout) {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf);
    merged.set(chunk, buf.length);
    buf = merged;
    while (buf.length >= frameBytes) {
      await processFrame(buf.subarray(0, frameBytes));
      buf = buf.slice(frameBytes);
    }
  }
  const code = await proc.exited;
  if (code !== 0 && !samples.length) throw new Error(`face scan failed: ${await new Response(proc.stderr).text()}`);
  onProgress?.(1);
  return { sampleFps: SAMPLE_FPS, samples: cleanTrack(samples) };
}
