// Hook proposals: alternative openings Claude prepares overnight; the creator picks one in the morning.
// A hook is a small, self-contained patch applied on top of the finished edit.
import { z } from "zod";
import { ClipSchema, EffectSchema, OverlaySchema, parseSpec, SfxSchema, type Spec } from "./spec";
import { layoutClips } from "./timeline";

export const HOOK_PATTERNS = [
  "cold_open", "bold_claim", "question", "contrarian", "pattern_interrupt", "list_promise", "result_first", "story_stakes", "other",
] as const;

export const HookSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "use letters, digits, - or _ (e.g. h1)"), // also the preview file name
  title: z.string().min(1).max(60), // short name shown to the creator, e.g. "Cold open: the laptop line"
  pattern: z.enum(HOOK_PATTERNS),
  why: z.string().min(1).max(400), // why it should stop the scroll
  score: z.number().min(1).max(10), // Claude's expected retention strength
  // Cold open: clips (SOURCE times) played BEFORE the edit; everything after shifts later automatically.
  prepend: z.array(ClipSchema).max(3).default([]),
  // Layers in FINAL output time (measured from the very start of the video, after any prepend).
  overlays: z.array(OverlaySchema).max(6).default([]),
  effects: z.array(EffectSchema).max(4).default([]),
  sfx: z.array(SfxSchema).max(4).default([]),
  hideCaptionsUntil: z.number().min(0).max(10).optional(), // keep captions off while the hook text is on screen
});
export type Hook = z.infer<typeof HookSchema>;

/** Seconds the prepended clips add before the original first clip starts. */
export function prependShift(spec: Spec, prepend: Hook["prepend"]): number {
  if (!prepend.length || !spec.clips.length) return 0;
  const next = { ...spec, clips: [...prepend, ...spec.clips] };
  const layouts = layoutClips(next);
  return layouts[prepend.length]!.start;
}

/** Apply a hook to an edit. Pure: returns a new, fully-defaulted spec. */
export function applyHook(spec: Spec, hook: Hook): Spec {
  const next = structuredClone(spec);
  const shift = prependShift(spec, hook.prepend);
  if (hook.prepend.length) {
    next.clips = [...hook.prepend.map((c, i) => ({ ...c, id: `hook-${c.id || i}` })), ...next.clips];
    const s = (t: number) => Math.round((t + shift) * 1000) / 1000;
    for (const o of next.overlays) {
      o.start = s(o.start);
      o.end = s(o.end);
    }
    for (const e of next.effects) {
      e.start = s(e.start);
      e.end = s(e.end);
    }
    for (const x of next.audio.sfx) x.at = s(x.at);
    for (const m of next.audio.music) {
      // music that starts the video keeps covering it (including the new opening)
      if (m.start > 0.05) m.start = s(m.start);
      if (m.end !== undefined) m.end = s(m.end);
    }
    next.captions.hide = next.captions.hide.map((h) => ({ start: s(h.start), end: s(h.end) }));
    next.captions.emphasis = next.captions.emphasis.map((e) => (e.at === undefined ? e : { ...e, at: s(e.at) }));
  }
  const tag = <T extends { id: string }>(x: T): T => ({ ...x, id: `hook-${x.id}` });
  next.overlays.push(...hook.overlays.map(tag));
  next.effects.push(...hook.effects.map(tag));
  next.audio.sfx.push(...hook.sfx.map(tag));
  if (hook.hideCaptionsUntil) next.captions.hide.push({ start: 0, end: hook.hideCaptionsUntil });
  return parseSpec(next);
}

/** Output-time window worth previewing for a hook (its graphics + a beat of the edit after it). */
export function hookPreviewSeconds(spec: Spec, hook: Hook): number {
  const ends = [
    prependShift(spec, hook.prepend),
    ...hook.overlays.map((o) => o.end),
    ...hook.effects.map((e) => e.end),
    hook.hideCaptionsUntil ?? 0,
  ];
  return Math.min(9, Math.max(4, Math.max(...ends) + 2));
}
