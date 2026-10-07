// Pure timeline math shared by the composition, the UI and Claude's tools.
// Frames are canonical (they must match Remotion exactly); seconds are derived from frames.
import type { Clip, FaceTrack, MediaAnalysis, MediaInfo, Reframe, Spec, Word } from "./spec";

export type ClipLayout = {
  clip: Clip;
  index: number;
  startFrame: number; // output frame where the clip begins (includes transition overlap)
  durationFrames: number;
  transitionFrames: number; // overlap with the previous clip (0 = hard cut)
  start: number; // seconds
  end: number; // seconds
};

export type Camera = { scale: number; tx: number; ty: number; originX: number; originY: number };

/**
 * Camera move for a clip at progress t (0..1). Push/pull/punch zoom towards `focus` (the face, else the centre);
 * pans hold a zoom of 1+amount and travel across the room that zoom creates. Photos with no move get a gentle push.
 */
export function cameraAt(
  motion: Clip["motion"],
  kind: "video" | "image" | "audio",
  t: number,
  canvas: { width: number; height: number },
  focus: { x: number; y: number } | null,
): Camera | null {
  const m = motion && motion.type !== "none" ? motion : kind === "image" ? { type: "pushIn" as const, amount: 0.06 } : null;
  if (!m || m.amount <= 0) return null;
  const e = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t))); // ease in-out
  const ox = focus?.x ?? canvas.width / 2;
  const oy = focus?.y ?? canvas.height / 2;
  const a = m.amount;
  switch (m.type) {
    case "pushIn": return { scale: 1 + a * e, tx: 0, ty: 0, originX: ox, originY: oy };
    case "pullOut": return { scale: 1 + a * (1 - e), tx: 0, ty: 0, originX: ox, originY: oy };
    case "punch": return { scale: 1 + a, tx: 0, ty: 0, originX: ox, originY: oy };
    default: {
      // Pans: scale about the centre, then slide within the spare margin (never revealing an edge).
      const s = 1 + a;
      const mx = (((s - 1) * canvas.width) / 2) * 0.95;
      const my = (((s - 1) * canvas.height) / 2) * 0.95;
      const k = 2 * e - 1; // -1 → 1
      const tx = m.type === "panLeft" ? k * mx : m.type === "panRight" ? -k * mx : 0;
      const ty = m.type === "panUp" ? k * my : m.type === "panDown" ? -k * my : 0;
      return { scale: s, tx, ty, originX: canvas.width / 2, originY: canvas.height / 2 };
    }
  }
}

/**
 * Speed ramp: split a clip into `n` equal source slices whose speeds follow a smooth curve
 * (upDown 1→peak→1, up 1→peak, down peak→1; peak < 1 = slow motion). Played back to back they read as one ramp.
 */
export function speedRampClips(clip: Clip, peak: number, shape: "upDown" | "up" | "down" = "upDown", n = 6): Clip[] {
  const p = Math.max(0.25, Math.min(4, peak));
  const len = (clip.out - clip.in) / n;
  const base = clip.speed;
  return Array.from({ length: n }, (_, k) => {
    const t = (k + 0.5) / n;
    const f = shape === "up" ? t : shape === "down" ? 1 - t : Math.sin(Math.PI * t);
    const speed = Math.max(0.25, Math.min(4, Math.round(base * (1 + (p - 1) * f) * 100) / 100));
    const seg: Clip = { ...clip, id: `${clip.id}~r${k + 1}`, in: Math.round((clip.in + k * len) * 1000) / 1000, out: Math.round((clip.in + (k + 1) * len) * 1000) / 1000, speed };
    if (k > 0) delete seg.transition;
    return seg;
  });
}

export function layoutClips(spec: Spec): ClipLayout[] {
  const fps = spec.format.fps;
  const out: ClipLayout[] = [];
  spec.clips.forEach((clip, index) => {
    const durationFrames = Math.max(1, Math.round(((clip.out - clip.in) / clip.speed) * fps));
    let transitionFrames = 0;
    const prev = out[index - 1];
    if (prev && clip.transition && clip.transition.type !== "cut") {
      // Remotion requires a transition to fit inside both neighbours; half of each keeps
      // back-to-back transitions from ever overlapping.
      transitionFrames = Math.floor(
        Math.min(clip.transition.duration * fps, prev.durationFrames / 2, durationFrames / 2),
      );
    }
    const startFrame = prev ? prev.startFrame + prev.durationFrames - transitionFrames : 0;
    out.push({
      clip,
      index,
      startFrame,
      durationFrames,
      transitionFrames,
      start: startFrame / fps,
      end: (startFrame + durationFrames) / fps,
    });
  });
  return out;
}

export function totalFrames(spec: Spec): number {
  const fps = spec.format.fps;
  const layouts = layoutClips(spec);
  const last = layouts[layouts.length - 1];
  const clipsEnd = last ? last.startFrame + last.durationFrames : 0;
  const overlayEnd = Math.ceil(Math.max(0, ...spec.overlays.map((o) => o.end)) * fps);
  // A voiceover keeps the video going until it has finished (its `end` is set when it's added).
  const voiceEnd = Math.ceil(Math.max(0, ...spec.audio.voice.map((v) => v.end ?? v.start)) * fps);
  return Math.max(1, clipsEnd, overlayEnd, voiceEnd);
}

export const totalSeconds = (spec: Spec) => totalFrames(spec) / spec.format.fps;

/** The clip on screen at an output time (the incoming one during a transition). */
export function clipAt(layouts: ClipLayout[], t: number): ClipLayout | undefined {
  let found: ClipLayout | undefined;
  for (const l of layouts) if (t >= l.start && t < l.end) found = l;
  return found;
}

export function sourceTimeAt(layout: ClipLayout, t: number): number {
  return layout.clip.in + (t - layout.start) * layout.clip.speed;
}

/** All output times at which a given source moment of a media appears. */
export function sourceToOutput(layouts: ClipLayout[], mediaId: string, s: number): number[] {
  return layouts
    .filter((l) => l.clip.mediaId === mediaId && s >= l.clip.in && s < l.clip.out)
    .map((l) => l.start + (s - l.clip.in) / l.clip.speed);
}

// ---------------------------------------------------------------- words / captions

export type OutputWord = { text: string; start: number; end: number; clipId: string };

const normWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

export function mapWords(
  spec: Spec,
  analysis: Record<string, MediaAnalysis>,
  applyCorrections = true,
): OutputWord[] {
  const words: OutputWord[] = [];
  for (const l of layoutClips(spec)) {
    const src: Word[] = analysis[l.clip.mediaId]?.words ?? [];
    for (const w of src) {
      const mid = (w.start + w.end) / 2;
      if (mid < l.clip.in || mid >= l.clip.out) continue;
      const start = Math.max(l.start, l.start + (w.start - l.clip.in) / l.clip.speed);
      const end = Math.min(l.end, l.start + (w.end - l.clip.in) / l.clip.speed);
      if (end > start) words.push({ text: w.text.trim(), start, end, clipId: l.clip.id });
    }
  }
  // Voiceover tracks speak too: their words caption and duck exactly like on-camera speech.
  for (const v of spec.audio.voice) {
    for (const w of analysis[v.mediaId]?.words ?? []) {
      if (w.start < v.offset) continue;
      const start = v.start + (w.start - v.offset);
      const end = v.start + (w.end - v.offset);
      if (v.end !== undefined && start >= v.end) continue;
      words.push({ text: w.text.trim(), start, end: v.end !== undefined ? Math.min(end, v.end) : end, clipId: `voice:${v.id}` });
    }
  }
  words.sort((a, b) => a.start - b.start);
  return applyCorrections ? correctWords(words, spec.captions.corrections) : words;
}

/** Apply caption corrections. `from` may be a phrase; an empty `to` deletes the word(s). */
export function correctWords(
  words: OutputWord[],
  corrections: { from: string; to: string }[],
): OutputWord[] {
  if (!corrections.length) return words;
  const result = words.map((w) => ({ ...w }));
  const removed = new Set<number>();
  for (const c of corrections) {
    const parts = c.from.split(/\s+/).map(normWord).filter(Boolean);
    if (!parts.length) continue;
    for (let i = 0; i + parts.length <= result.length; i++) {
      if (removed.has(i)) continue;
      let match = true;
      for (let k = 0; k < parts.length; k++) {
        if (removed.has(i + k) || normWord(result[i + k]!.text) !== parts[k]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const first = result[i]!;
      const last = result[i + parts.length - 1]!;
      if (c.to.trim() === "") {
        for (let k = 0; k < parts.length; k++) removed.add(i + k);
      } else {
        // Keep the original's trailing punctuation ("Jordn." -> "Jordan.") so sentence breaks survive.
        const trailing = /[^\p{L}\p{N}']+$/u.exec(last.text)?.[0] ?? "";
        first.text = /[^\p{L}\p{N}']$/u.test(c.to) ? c.to : c.to + trailing;
        first.end = last.end;
        for (let k = 1; k < parts.length; k++) removed.add(i + k);
      }
    }
  }
  return result.filter((_, i) => !removed.has(i));
}

export type CaptionPage = { start: number; end: number; words: OutputWord[] };

/** Clips added by a hook (see applyHook) carry this prefix. */
export const isHookClip = (clipId?: string) => !!clipId?.startsWith("hook-");

export function paginateWords(words: OutputWord[], maxWords: number, maxGap = 0.6): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let cur: OutputWord[] = [];
  const flush = () => {
    if (cur.length) pages.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const sentenceEnd = prev && /[.!?؟،,]$/.test(prev.text);
    // A hook's cold open is a different moment of the video: never share a caption page across that cut.
    const hookEdge = prev && prev.clipId !== w.clipId && (isHookClip(prev.clipId) || isHookClip(w.clipId));
    if (cur.length >= maxWords || (prev && w.start - prev.end > maxGap) || sentenceEnd || hookEdge) flush();
    cur.push(w);
  }
  flush();
  // Hold each page until the next one starts if the gap is short (avoids flicker).
  for (let i = 0; i < pages.length - 1; i++) {
    const gap = pages[i + 1]!.start - pages[i]!.end;
    if (gap > 0 && gap < 0.35) pages[i]!.end = pages[i + 1]!.start;
  }
  return pages;
}

/** Merged time ranges where someone is speaking (output time) - used for music ducking. */
export function speechIntervals(words: OutputWord[], joinGap = 0.4): [number, number][] {
  const out: [number, number][] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && w.start - last[1] <= joinGap) last[1] = Math.max(last[1], w.end);
    else out.push([w.start, w.end]);
  }
  return out;
}

// ---------------------------------------------------------------- faces

export type Face = {
  cx: number; cy: number; w: number; h: number;
  eyes: [number, number][]; mouth: [number, number][]; // normalized source coords
};

function sampleToFace(s: number[]): Face {
  return {
    cx: s[0]!, cy: s[1]!, w: s[2]!, h: s[3]!,
    eyes: [[s[4]!, s[5]!], [s[6]!, s[7]!]],
    mouth: [[s[8]!, s[9]!], [s[10]!, s[11]!]],
  };
}

/** Face at a source time, linearly interpolated between samples. */
export function faceAt(track: FaceTrack | undefined, t: number): Face | null {
  if (!track || !track.samples.length) return null;
  const pos = t * track.sampleFps;
  const i0 = Math.max(0, Math.min(track.samples.length - 1, Math.floor(pos)));
  const i1 = Math.min(track.samples.length - 1, i0 + 1);
  const a = track.samples[i0];
  const b = track.samples[i1];
  if (a && b) {
    const k = Math.max(0, Math.min(1, pos - i0));
    return sampleToFace(a.map((v, j) => v + (b[j]! - v) * k));
  }
  const one = a ?? b;
  return one ? sampleToFace(one) : null;
}

/** Face centre averaged over a window — steadier for reframing than the raw track. */
export function smoothFaceCenter(track: FaceTrack | undefined, t: number, window = 1.2): { x: number; y: number } | null {
  if (!track || !track.samples.length) return null;
  const from = Math.max(0, Math.floor((t - window / 2) * track.sampleFps));
  const to = Math.min(track.samples.length - 1, Math.ceil((t + window / 2) * track.sampleFps));
  let sx = 0, sy = 0, n = 0;
  for (let i = from; i <= to; i++) {
    const s = track.samples[i];
    if (s) { sx += s[0]!; sy += s[1]!; n++; }
  }
  return n ? { x: sx / n, y: sy / n } : null;
}

// ---------------------------------------------------------------- reframing geometry

export type Placement = {
  mode: "fill" | "fit" | "blur" | "face";
  width: number; height: number; // displayed size of the source on the canvas (px)
  left: number; top: number;
};

export function resolveReframe(spec: Spec, clip: Clip): Reframe {
  return { ...spec.reframe, ...(clip.reframe ?? {}) } as Reframe;
}

export function placeSource(
  media: Pick<MediaInfo, "width" | "height"> & { kind?: MediaInfo["kind"] },
  canvas: { width: number; height: number },
  reframe: Reframe,
  face: { x: number; y: number } | null,
): Placement {
  const W = canvas.width, H = canvas.height;
  const w = media.width || W, h = media.height || H;
  let mode = reframe.mode;
  if (mode === "auto") {
    const r = w / h / (W / H);
    const cropLoss = 1 - Math.min(r, 1 / r); // share of the source a fill-crop throws away
    // Photos fill when the crop is modest (a 3:4 phone photo on a 9:16 Short); video only when nearly identical.
    const close = media.kind === "image" ? cropLoss <= 0.26 : Math.abs(w / h - W / H) < 0.06;
    if (close) mode = "fill";
    else if (W / H < w / h) mode = face ? "face" : "blur"; // tall canvas, wide source
    else mode = "blur"; // wide canvas, tall source
  }
  if (mode === "face" && !face) mode = "fill";
  if (mode === "fit" || mode === "blur") {
    const s = Math.min(W / w, H / h) * reframe.zoom;
    const sw = w * s, sh = h * s;
    return { mode, width: sw, height: sh, left: (W - sw) / 2, top: (H - sh) / 2 };
  }
  const s = Math.max(W / w, H / h) * reframe.zoom;
  const sw = w * s, sh = h * s;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  let left = (W - sw) / 2 - (reframe.offsetX * (sw - W)) / 2;
  let top = (H - sh) / 2 - (reframe.offsetY * (sh - H)) / 2;
  if (mode === "face" && face) {
    left = clamp(W / 2 - face.x * sw + (reframe.offsetX * (sw - W)) / 2, W - sw, 0);
    top = clamp(H * 0.42 - face.y * sh, H - sh, 0); // eyes-line slightly above centre
  }
  return { mode: mode as Placement["mode"], width: sw, height: sh, left, top };
}
