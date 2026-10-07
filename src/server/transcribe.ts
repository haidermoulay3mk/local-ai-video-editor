// Local speech-to-text with whisper.cpp: word-level timestamps, auto language (English, Arabic, ...).
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Word } from "../shared/spec";
import { WHISPER_MODEL, whisperExePath, whisperModelPath } from "./config";
import { run } from "./media";

type Token = { text: string; t_dtw?: number; p?: number; offsets: { from: number; to: number } };
type Item = { text: string; offsets: { from: number; to: number }; tokens?: Token[] };
type WhisperJson = { result?: { language?: string }; transcription: Item[] };

const NOISE = /^[\[(].*[\])]$/; // [MUSIC], (laughs), [BLANK_AUDIO] ...

/**
 * Whisper's DTW alignment sometimes collapses several consecutive words onto ONE onset (usually the
 * start of the next phrase), which would show captions seconds late. Words in such runs — and words
 * whose onset sits inside a detected silence — are unreliable: spread them across the actual speech
 * time between their trustworthy neighbours, weighted by word length.
 */
export function repairTimings(words: Word[], silences: { start: number; end: number }[]): Word[] {
  const n = words.length;
  if (n < 2) return words;
  const long = silences.filter((s) => s.end - s.start >= 0.3);
  const bad = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n; i++) {
    if (Math.abs(words[i]!.start - words[i - 1]!.start) < 0.02) bad[i] = bad[i - 1] = true;
  }
  words.forEach((w, i) => {
    if (long.some((s) => w.start > s.start + 0.12 && w.start < s.end - 0.12)) bad[i] = true;
  });
  const out = words.map((w) => ({ ...w }));
  let i = 0;
  while (i < n) {
    if (!bad[i]) { i++; continue; }
    let j = i;
    while (j < n && bad[j]) j++; // unreliable run [i, j)
    const prev = out[i - 1];
    const lo = prev ? Math.max(prev.start + 0.08, Math.min(prev.end, prev.start + 0.9)) : 0;
    const hi = j < n ? out[j]!.start : Math.max(lo + 0.35 * (j - i), ...words.slice(i, j).map((w) => w.end));
    let segs: [number, number][] = [[lo, Math.max(lo + 0.05, hi)]];
    for (const s of long) {
      segs = segs.flatMap(([a, b]): [number, number][] =>
        s.end <= a || s.start >= b ? [[a, b]] : [[a, Math.max(a, s.start)], [Math.min(b, s.end), b]]);
    }
    // Slivers shorter than a syllable (e.g. 60 ms between a silence and the next word) can't hold a word.
    const usable = segs.filter(([a, b]) => b - a >= 0.15);
    segs = usable.length ? usable : segs.filter(([a, b]) => b - a > 0.04);
    if (!segs.length) segs = [[lo, Math.max(lo + 0.05, hi)]];
    const total = segs.reduce((t, [a, b]) => t + b - a, 0);
    const weights = out.slice(i, j).map((w) => Math.max(1, w.text.replace(/[^\p{L}\p{N}]/gu, "").length));
    const wsum = weights.reduce((a, b) => a + b, 0);
    const at = (x: number) => {
      for (const [a, b] of segs) {
        if (x <= b - a + 1e-9) return a + x;
        x -= b - a;
      }
      return segs[segs.length - 1]![1];
    };
    let acc = 0;
    for (let k = i; k < j; k++) {
      const share = (weights[k - i]! / wsum) * total;
      out[k]!.start = at(acc);
      out[k]!.end = Math.max(out[k]!.start + 0.05, at(acc + share));
      acc += share;
    }
    i = j;
  }
  return out;
}

/** Convert whisper.cpp "-ml 1 -sow" output (one word per item) into clean words in seconds. */
export function parseWhisper(json: WhisperJson): { words: Word[]; language: string } {
  const raw: { text: string; start: number; coarseEnd: number }[] = [];
  for (const item of json.transcription) {
    const text = item.text.trim();
    if (!text || NOISE.test(text)) continue;
    const real = (item.tokens ?? []).filter((t) => !t.text.startsWith("[_") && t.text.trim() !== "");
    const dtw = real[0]?.t_dtw;
    // DTW onsets are accurate; segment offsets can drift by seconds around pauses.
    let start = dtw !== undefined && dtw >= 0 ? dtw / 100 : item.offsets.from / 1000; // t_dtw is in 10 ms units
    const prev = raw[raw.length - 1];
    if (prev && start < prev.start) start = prev.start;
    // Punctuation-only items glue onto the previous word ("Hello" + "," -> "Hello,")
    if (prev && /^[^\p{L}\p{N}]+$/u.test(text)) {
      prev.text += text;
      continue;
    }
    raw.push({ text, start, coarseEnd: item.offsets.to / 1000 });
  }
  // DTW gives onsets only. End = next onset, but never longer than a plausible spoken length,
  // so a word before a pause doesn't "last" through the pause (matters for captions + ducking).
  const words: Word[] = raw.map((w, i) => {
    const next = raw[i + 1];
    const letters = w.text.replace(/[^\p{L}\p{N}]/gu, "").length;
    const plausible = w.start + Math.min(0.9, Math.max(0.15, 0.07 * letters + 0.12));
    const fromSegment = w.coarseEnd > w.start + 0.05 && w.coarseEnd < plausible + 0.4 ? w.coarseEnd : plausible;
    let end = next ? Math.min(next.start, fromSegment) : fromSegment;
    if (end < w.start + 0.06) end = next ? Math.max(next.start, w.start + 0.06) : w.start + 0.06;
    return { text: w.text, start: w.start, end };
  });
  return { words, language: json.result?.language ?? "auto" };
}

export async function transcribe(wav16k: string, outDir: string, onProgress?: (p: number) => void): Promise<{ words: Word[]; language: string }> {
  const exe = whisperExePath();
  const model = whisperModelPath();
  if (!existsSync(exe) || !existsSync(model)) throw new Error("whisper.cpp is not installed — run `bun run setup`");
  const outBase = path.join(outDir, "whisper");
  const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
  const res = await run(
    // -nfa: whisper.cpp >= 1.8 enables flash-attention by default, which silently disables DTW
    // token alignment (every t_dtw comes back -1 and words drift by seconds around pauses).
    [exe, "-m", model, "-f", wav16k, "-l", "auto", "-ojf", "-of", outBase, "-ml", "1", "-sow",
      "--dtw", WHISPER_MODEL, "-nfa", "-pp", "-t", threads],
    (chunk) => {
      const m = /progress =\s*(\d+)%/.exec(chunk);
      if (m) onProgress?.(Number(m[1]) / 100);
    },
  );
  const jsonFile = `${outBase}.json`;
  if (!existsSync(jsonFile)) throw new Error(`whisper produced no output (exit ${res.code}): ${res.stderr.slice(-300)}`);
  return parseWhisper(JSON.parse(readFileSync(jsonFile, "utf8")) as WhisperJson);
}
