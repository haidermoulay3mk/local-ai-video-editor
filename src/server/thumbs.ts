// Thumbnails / covers: the strongest face moment of the edit (or a photo / clip middle when there's no face) with a
// big outlined title, rendered by the same Remotion engine as the video so fonts and grades match.
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { parseSpec, type SpecInput } from "../shared/spec";
import { renderStillsJob } from "./render-client";
import { compositionProps, getAnalysis, getProject, now, type Project, projectDir, saveProject, type ThumbRecord } from "./store";

export type Moment = { mediaId: string; t: number; cx: number; score: number };

/** Candidate moments inside the edit's clips: big, central, upright faces, at least 3 s apart; else photos / clip middles. */
export function thumbMoments(p: Project, count: number): Moment[] {
  const all: Moment[] = [];
  for (const c of p.spec.clips) {
    const m = p.media.find((x) => x.id === c.mediaId);
    if (!m || m.kind === "audio") continue;
    if (m.kind === "image") {
      all.push({ mediaId: m.id, t: 0, cx: 0.5, score: 0.002 });
      continue;
    }
    const track = getAnalysis(p.id, m.id).faces;
    let found = false;
    track?.samples.forEach((s, i) => {
      const t = i / track.sampleFps;
      if (!s || t < c.in + 0.3 || t > c.out - 0.3) return;
      const [cx, cy, w, h] = s as [number, number, number, number];
      // Bigger faces read better as thumbnails (up to ~a third of the frame); centred and eye-line high is best.
      const score = Math.min(w * h, 0.12) * (1 - Math.abs(cx - 0.5) * 0.6) * (1 - Math.abs(cy - 0.42) * 0.8);
      all.push({ mediaId: m.id, t, cx, score });
      found = true;
    });
    if (!found) all.push({ mediaId: m.id, t: (c.in + c.out) / 2, cx: 0.5, score: 0.001 });
  }
  all.sort((a, b) => b.score - a.score);
  const out: Moment[] = [];
  for (const mo of all) {
    if (out.some((o) => o.mediaId === mo.mediaId && Math.abs(o.t - mo.t) < 3)) continue;
    out.push(mo);
    if (out.length >= count) break;
  }
  return out;
}

const VARIANTS = ["outline", "accent", "box"] as const;
type Variant = (typeof VARIANTS)[number];

/** A one-frame edit: the moment, punchy grade + face light, and the title opposite the face. */
export function thumbSpec(p: Project, mo: Moment, text: string, variant: Variant, emoji?: string) {
  const wide = p.spec.format.width >= p.spec.format.height;
  const W = wide ? 1280 : 1080, H = wide ? 720 : 1920;
  const accent = p.spec.brand.colors[0] ?? "#FFD400";
  const words = text.trim().split(/\s+/);
  const longest = Math.max(4, ...words.map((w) => w.length));
  const maxW = wide ? 0.52 : 0.9;
  const size = Math.round(Math.min(wide ? 190 : 170, (maxW * W) / (longest * 0.5)));
  const x = wide ? (mo.cx < 0.5 ? 0.72 : 0.28) : 0.5;
  const y = wide ? 0.5 : 0.2;
  const lead = Math.min(0.6, mo.t);
  const style =
    variant === "box"
      ? { font: "Anton", size, color: "#111111", background: accent, radius: 18, shadow: true, uppercase: true, lineHeight: 1.0 }
      : { font: "Anton", size, color: variant === "accent" ? accent : "#FFFFFF", strokeColor: "#000000", strokeWidth: Math.round(size * 0.1), shadow: true, uppercase: true, lineHeight: 0.95 };
  const input: SpecInput = {
    format: { preset: wide ? "youtube" : "short", width: W, height: H, fps: 30 },
    clips: [{ id: "thumb", mediaId: mo.mediaId, in: mo.t - lead, out: mo.t - lead + 1.5, motion: { type: "none", amount: 0 } }],
    reframe: p.spec.reframe,
    grade: { preset: "vibrant", contrast: 1.12, saturation: 1.12, vignette: 0.35 },
    retouch: { faceLight: 0.35, skinSmooth: p.spec.retouch.skinSmooth },
    captions: { enabled: false },
    brand: p.spec.brand,
    overlays: [
      { type: "text", id: "title", start: 0, end: 1.5, text, x, y, maxWidth: maxW, rotation: wide ? -2 : 0, anim: { in: "none", out: "none" }, style: style as never },
      ...(emoji ? [{ type: "template" as const, id: "emoji", template: "emojiPop" as const, start: 0, end: 1.5, x: wide ? x + (x > 0.5 ? 0.17 : -0.17) : 0.82, y: wide ? 0.2 : 0.09, props: { emoji, size: wide ? 150 : 170 } }] : []),
    ],
  };
  return { spec: parseSpec(input), at: lead };
}

/** Render `count` thumbnail options (different moments / styles). Returns the records and the images for review. */
export async function makeThumbnails(p: Project, input: { text: string; emoji?: string; count?: number; moments?: { mediaId: string; t: number }[] }) {
  const text = input.text.trim().slice(0, 60);
  if (!text) throw new Error("text is empty — 2-5 punchy words work best");
  if (!p.spec.clips.length) throw new Error("the edit has no clips yet — thumbnails use a frame of the video");
  const count = Math.max(1, Math.min(4, input.count ?? 3));
  const moments: Moment[] = input.moments?.length
    ? input.moments.map((m) => ({ ...m, cx: getAnalysis(p.id, m.mediaId).faces?.samples[Math.round(m.t * 5)]?.[0] ?? 0.5, score: 1 }))
    : thumbMoments(p, count);
  if (!moments.length) throw new Error("no usable frame in the edit");
  const dir = path.join(projectDir(p.id), "thumbnails");
  mkdirSync(dir, { recursive: true });
  const base = compositionProps(p, false);
  const made: ThumbRecord[] = [];
  const images: { file: string; base64: string }[] = [];
  for (let i = 0; i < count; i++) {
    const mo = moments[i % moments.length]!;
    const variant = VARIANTS[i % VARIANTS.length]!;
    const { spec, at } = thumbSpec(p, mo, text, variant, input.emoji);
    const [still] = await renderStillsJob({ ...base, spec }, [at], path.join(dir, "tmp"), 1).done;
    const file = `thumb-${Date.now().toString(36)}-${i + 1}.jpg`;
    renameSync(still!, path.join(dir, file));
    made.push({ file, text, mediaId: mo.mediaId, t: Math.round(mo.t * 100) / 100, createdAt: now() });
    images.push({ file, base64: readFileSync(path.join(dir, file)).toString("base64") });
  }
  const fresh = getProject(p.id)!;
  fresh.thumbnails = [...made, ...(fresh.thumbnails ?? [])].slice(0, 24);
  saveProject(fresh);
  return { thumbnails: made, images };
}
