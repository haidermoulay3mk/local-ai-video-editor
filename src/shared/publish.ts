// Publish kit: subtitle files (SRT / VTT) from the edit's spoken words, chapters, and the upload text
// (title / description / hashtags / credits) the creator copies into YouTube, TikTok or Instagram.
import { z } from "zod";
import type { MediaAnalysis, Spec } from "./spec";
import { mapWords } from "./timeline";

export type Cue = { start: number; end: number; text: string };

/**
 * Readable subtitle cues (output time): at most `maxChars` characters and `maxDur` seconds each, broken at sentence
 * ends and pauses. Every spoken word is included (also voiceovers whose burned-in captions are off).
 */
export function subtitleCues(spec: Spec, analysis: Record<string, MediaAnalysis>, maxChars = 42, maxDur = 5): Cue[] {
  const words = mapWords(spec, analysis).filter((w) => w.text);
  const cues: Cue[] = [];
  let cur: typeof words = [];
  const flush = () => {
    if (cur.length) cues.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.text).join(" ") });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (len > maxChars || w.end - cur[0]!.start > maxDur || w.start - prev.end > 0.8 || /[.!?؟]$/.test(prev.text))) flush();
    cur.push(w);
  }
  flush();
  // No overlaps; very short cues stay up a little longer when there's room.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const c = cues[i]!;
    if (c.end - c.start < 0.8) c.end = c.start + 0.8;
    if (next && c.end > next.start) c.end = next.start;
  }
  return cues;
}

const stamp = (t: number, sep: "," | ".") => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
};

export const toSrt = (cues: Cue[]) =>
  cues.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n");

export const toVtt = (cues: Cue[]) =>
  `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n")}`;

// ---------------------------------------------------------------- chapters + upload text

export const ChapterSchema = z.object({ at: z.number().min(0), title: z.string().min(1).max(100) });
export const PublishSchema = z.object({
  title: z.string().min(1).max(100), // YouTube's limit
  description: z.string().max(4500).default(""),
  hashtags: z.array(z.string().regex(/^#?[\p{L}\p{N}_]{1,40}$/u, "hashtags are one word, no spaces")).max(15).default([]),
  chapters: z.array(ChapterSchema).max(60).default([]),
  pinnedComment: z.string().max(500).optional(),
});
export type Chapter = z.infer<typeof ChapterSchema>;
export type PublishInfo = z.infer<typeof PublishSchema>;

/** 0:00 / 1:05 / 1:02:03 (YouTube chapter format). */
export function fmtChapterTime(t: number): string {
  const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** YouTube only shows chapters when: first at 0:00, at least 3, each at least 10 s long, inside the video. */
export function chapterProblems(chapters: Chapter[], total: number): string[] {
  if (!chapters.length) return [];
  const out: string[] = [];
  const sorted = [...chapters].sort((a, b) => a.at - b.at);
  if (sorted[0]!.at !== 0) out.push("the first chapter must start at 0:00");
  if (sorted.length < 3) out.push("YouTube needs at least 3 chapters");
  sorted.forEach((c, i) => {
    const next = sorted[i + 1]?.at ?? total;
    if (next - c.at < 10) out.push(`chapter "${c.title}" is shorter than 10 s`);
    if (c.at >= total) out.push(`chapter "${c.title}" starts after the video ends`);
  });
  return out;
}

/** The full description to paste: text, chapters, hashtags, then credits for stock media. */
export function publishText(info: PublishInfo, credits: string[]): string {
  const parts = [info.description.trim()];
  if (info.chapters.length) parts.push([...info.chapters].sort((a, b) => a.at - b.at).map((c) => `${fmtChapterTime(c.at)} ${c.title}`).join("\n"));
  if (info.hashtags.length) parts.push(info.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" "));
  if (credits.length) parts.push(`Stock media:\n${credits.map((c) => `• ${c}`).join("\n")}`);
  return parts.filter(Boolean).join("\n\n");
}
