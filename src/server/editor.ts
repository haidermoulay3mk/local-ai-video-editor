// Editing operations used by Claude's tools (via HTTP) and the UI. Every write goes through
// schema + media-aware validation, and every accepted change is undoable.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { parseChat } from "../shared/chat";
import { chapterProblems, PublishSchema, publishText } from "../shared/publish";
import { applyHook, HookSchema } from "../shared/hooks";
import { type Clip, SFX_NAMES, type Spec, SpecSchema } from "../shared/spec";
import { layoutClips, mapWords, speedRampClips, totalSeconds } from "../shared/timeline";
import { enqueueIngest, fixMedia, undoFix } from "./ingest";
import { autoFixOptions } from "./look";
import { keyStatus } from "./keys";
import { stockCredits } from "./stock";
import { grabFrames } from "./media";
import { generateTrack, getTrack, importTrack, LICENSES, type MusicQuery, searchTracks, type Track } from "./music";
import { GEN_STYLES, type GenStyle } from "./music-gen";
import { renderStillsJob } from "./render-client";
import {
  type ClipIdea, compositionProps, getAnalysis, getProject, mediaDir, newMediaRecord, now, type Project, projectDir, saveProject, setSpec,
  type StoredHook,
} from "./store";
import { DEFAULT_VOICE, synthesizeVoice, type VoiceId, VOICES } from "./tts";

export type EditResult = { ok: boolean; errors: string[]; warnings: string[]; summary: string };

function zodErrors(err: z.ZodError): string[] {
  return err.issues.slice(0, 25).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** Checks that need the project (media exists, times inside the file, ...). */
export function semanticCheck(spec: Spec, p: Project): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = new Map(p.media.map((m) => [m.id, m]));
  const ready = (id: string) => media.get(id)?.steps.probe?.state === "done";
  const ids = new Set<string>();
  const dup = (id: string, where: string) => {
    if (ids.has(id)) warnings.push(`duplicate id "${id}" (${where}) — ids should be unique`);
    ids.add(id);
  };
  spec.clips.forEach((c, i) => {
    dup(c.id, `clips[${i}]`);
    const m = media.get(c.mediaId);
    if (!m) return void errors.push(`clips[${i}] (${c.id}): unknown mediaId "${c.mediaId}"`);
    if (!ready(c.mediaId)) errors.push(`clips[${i}] (${c.id}): media "${c.mediaId}" is still processing`);
    if (c.out <= c.in) errors.push(`clips[${i}] (${c.id}): out (${c.out}) must be greater than in (${c.in})`);
    if (m.kind !== "image" && m.duration && c.out > m.duration + 0.05) {
      errors.push(`clips[${i}] (${c.id}): out ${c.out}s is past the end of "${m.name}" (${m.duration.toFixed(2)}s)`);
    }
  });
  spec.overlays.forEach((o, i) => {
    dup(o.id, `overlays[${i}]`);
    if (o.end <= o.start) errors.push(`overlays[${i}] (${o.id}): end must be greater than start`);
    if ((o.type === "image" || o.type === "video") && !media.has(o.mediaId)) errors.push(`overlays[${i}] (${o.id}): unknown mediaId "${o.mediaId}"`);
    if (o.type === "video") {
      const m = media.get(o.mediaId);
      if (m && m.kind !== "video") errors.push(`overlays[${i}] (${o.id}): media "${o.mediaId}" is not a video`);
      if (m && o.in >= m.duration) errors.push(`overlays[${i}] (${o.id}): in ${o.in}s is past the end of the video`);
    }
    if (o.type === "image" && media.has(o.mediaId) && media.get(o.mediaId)?.kind !== "image") errors.push(`overlays[${i}] (${o.id}): media is not an image`);
  });
  spec.effects.forEach((e, i) => {
    dup(e.id, `effects[${i}]`);
    if (e.end <= e.start) errors.push(`effects[${i}] (${e.id}): end must be greater than start`);
  });
  spec.audio.music.forEach((mu, i) => {
    dup(mu.id, `music[${i}]`);
    const m = media.get(mu.mediaId);
    if (!m) errors.push(`music[${i}]: unknown mediaId "${mu.mediaId}"`);
    else if (!m.hasAudio) errors.push(`music[${i}]: "${m.name}" has no audio`);
  });
  spec.audio.voice.forEach((v, i) => {
    dup(v.id, `voice[${i}]`);
    const m = media.get(v.mediaId);
    if (!m) errors.push(`voice[${i}]: unknown mediaId "${v.mediaId}"`);
    else if (!m.hasAudio) errors.push(`voice[${i}]: "${m.name}" has no audio`);
    if (v.end !== undefined && v.end <= v.start) errors.push(`voice[${i}] (${v.id}): end must be greater than start`);
  });
  spec.audio.sfx.forEach((s, i) => {
    dup(s.id, `sfx[${i}]`);
    if (!(SFX_NAMES as readonly string[]).includes(s.sound) && !media.get(s.sound)?.hasAudio) {
      errors.push(`sfx[${i}]: sound must be one of ${SFX_NAMES.join(", ")} or an audio mediaId`);
    }
  });
  if (spec.layout.mode === "split") {
    const f = spec.layout.mediaId ? media.get(spec.layout.mediaId) : undefined;
    if (!spec.layout.mediaId) errors.push("layout: split mode needs layout.mediaId (the filler video for the other half)");
    else if (!f) errors.push(`layout: unknown mediaId "${spec.layout.mediaId}"`);
    else if (f.kind === "audio") errors.push("layout: the split filler must be a video or an image");
    else if (spec.clips.some((c) => c.mediaId === f.id)) warnings.push("layout: the filler is also used as a main clip");
    if (spec.captions.enabled && Math.abs(spec.captions.y - spec.layout.ratio) > 0.12) {
      warnings.push(`captions sit at y=${spec.captions.y} — on a split screen they read best on the seam (captions.y ≈ ${spec.layout.ratio})`);
    }
  }
  if (spec.brand.avatar && media.get(spec.brand.avatar)?.kind !== "image") errors.push(`brand.avatar must be the mediaId of an image`);
  spec.overlays.forEach((o, i) => {
    if (o.type !== "template") return;
    if (o.template === "chat") {
      const n = parseChat(String(o.props.messages ?? "")).length;
      const per = Number(o.props.perMessage);
      const need = 0.35 + n * (Number.isFinite(per) && per > 0 ? per : 0.6) + 0.5;
      if (!n) errors.push(`overlays[${i}] (${o.id}): chat needs props.messages like "me: hi|Sam: hey"`);
      else if (o.end - o.start < need) warnings.push(`overlays[${i}] (${o.id}): ${n} chat messages need ≥ ${need.toFixed(1)}s on screen (layer is ${(o.end - o.start).toFixed(1)}s) — lengthen it or lower perMessage`);
    }
    for (const k of ["avatar", "leftImage", "rightImage", "contactAvatar"]) {
      const id = o.props[k];
      if (typeof id === "string" && id && media.get(id)?.kind !== "image") errors.push(`overlays[${i}] (${o.id}): props.${k} must be the mediaId of an image`);
    }
  });
  const total = totalSeconds(spec);
  const end = layoutClips(spec).at(-1)?.end ?? 0;
  if (spec.overlays.some((o) => o.end > end + 0.05) && end > 0) warnings.push("some overlays extend past the last clip (video gets longer, background shows)");
  if (spec.captions.enabled && !p.media.some((m) => getAnalysis(p.id, m.id).words?.length)) warnings.push("captions are on but no transcript exists yet");
  if (spec.format.preset === "short" && total > 180) warnings.push(`${total.toFixed(0)}s is longer than Shorts/Reels allow (180s)`);
  if (spec.audio.enhanceVoice && !p.media.some((m) => m.enhanced)) warnings.push("enhanceVoice is on but no enhanced audio exists (no speech media)");
  return { errors, warnings };
}

export function summarize(spec: Spec): string {
  const kinds = spec.overlays.reduce<Record<string, number>>((acc, o) => {
    const k = o.type === "template" ? o.template : o.type;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  return [
    `duration ${totalSeconds(spec).toFixed(2)}s @ ${spec.format.width}x${spec.format.height}`,
    `${spec.clips.length} clips`,
    `${spec.overlays.length} overlays${spec.overlays.length ? ` (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`,
    `captions ${spec.captions.enabled ? spec.captions.style : "off"}`,
    `grade ${spec.grade.preset}`,
    `${spec.effects.length} effects, ${spec.audio.music.length} music${spec.audio.music.some((m) => m.guide) ? " (incl. guide track — not exported)" : ""}, ${spec.audio.sfx.length} sfx, ${spec.audio.voice.length} voiceover`,
  ].join(" | ");
}

export function applySpec(p: Project, input: unknown, reason: string): EditResult {
  const parsed = SpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error), warnings: [], summary: summarize(p.spec) };
  const { errors, warnings } = semanticCheck(parsed.data, p);
  if (errors.length) return { ok: false, errors, warnings, summary: summarize(p.spec) };
  // A normal edit made on top of an applied hook bakes that hook in (so a later hook swap can't lose this edit).
  if (p.hookBase && !reason.startsWith("hook:") && reason !== "remove hook") p.hookBase = undefined;
  setSpec(p.id, parsed.data, reason);
  return { ok: true, errors: [], warnings, summary: summarize(parsed.data) };
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!plain(base) || !plain(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = v === null ? undefined : deepMerge(base[k], v);
  return out;
}

const raw = (p: Project) => JSON.parse(JSON.stringify(p.spec)) as Spec;

export function updateSettings(p: Project, patch: Record<string, unknown>, reason: string): EditResult {
  const allowed = ["format", "background", "captions", "grade", "retouch", "reframe", "audio", "layout", "brand"];
  const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
  if (bad.length) return { ok: false, errors: [`unknown setting(s): ${bad.join(", ")} (allowed: ${allowed.join(", ")})`], warnings: [], summary: summarize(p.spec) };
  // music/sfx are layers (edited by id), never merged as settings.
  if (plain(patch.audio) && ("music" in patch.audio || "sfx" in patch.audio || "voice" in patch.audio)) {
    return { ok: false, errors: ["edit music/sfx/voice with upsert_layers / remove_layers"], warnings: [], summary: summarize(p.spec) };
  }
  return applySpec(p, deepMerge(raw(p), patch), reason);
}

type Layered = { id: string };
function upsert(list: Layered[], items: unknown[] | undefined): Layered[] {
  if (!items?.length) return list;
  const out = [...list];
  for (const it of items as Layered[]) {
    const i = out.findIndex((x) => x.id === it.id);
    if (i >= 0) out[i] = it;
    else out.push(it);
  }
  return out;
}

export function upsertLayers(
  p: Project,
  input: { overlays?: unknown[]; effects?: unknown[]; music?: unknown[]; sfx?: unknown[]; voice?: unknown[] },
  reason: string,
): EditResult {
  const s = raw(p);
  const next = {
    ...s,
    overlays: upsert(s.overlays, input.overlays),
    effects: upsert(s.effects, input.effects),
    audio: {
      ...s.audio,
      music: upsert(s.audio.music, input.music),
      sfx: upsert(s.audio.sfx, input.sfx),
      voice: upsert(s.audio.voice, input.voice),
    },
  };
  return applySpec(p, next, reason);
}

export function removeLayers(p: Project, ids: string[], reason: string): EditResult {
  const set = new Set(ids);
  const s = raw(p);
  const count = (x: Spec) =>
    x.overlays.length + x.effects.length + x.audio.music.length + x.audio.sfx.length + x.audio.voice.length + x.clips.length;
  const next: Spec = {
    ...s,
    clips: s.clips.filter((x) => !set.has(x.id)),
    overlays: s.overlays.filter((x) => !set.has(x.id)),
    effects: s.effects.filter((x) => !set.has(x.id)),
    audio: {
      ...s.audio,
      music: s.audio.music.filter((x) => !set.has(x.id)),
      sfx: s.audio.sfx.filter((x) => !set.has(x.id)),
      voice: s.audio.voice.filter((x) => !set.has(x.id)),
    },
  };
  const r = applySpec(p, next, reason);
  if (r.ok && count(s) === count(next)) r.warnings.push(`no layer matched ids: ${ids.join(", ")}`);
  return r;
}

export function setClips(p: Project, clips: unknown[], reason: string): EditResult {
  return applySpec(p, { ...raw(p), clips }, reason);
}

// ---------------------------------------------------------------- auto cut (jump cuts)

const FILLERS = new Set(["um", "uh", "uhm", "umm", "erm", "er", "ah", "hmm", "mm", "eh"]);

export type AutoCutOptions = {
  mediaId: string;
  method?: "words" | "silence";
  minSilence?: number; // gaps longer than this are removed (s)
  padding?: number; // breathing room kept around speech (s)
  removeFillers?: boolean;
  from?: number;
  to?: number;
  punchIn?: boolean; // alternate a held zoom on every other jump cut (hides the cut, adds energy)
};

export function autoCutRegions(p: Project, o: AutoCutOptions): { start: number; end: number }[] {
  const m = p.media.find((x) => x.id === o.mediaId);
  if (!m) throw new Error(`unknown mediaId ${o.mediaId}`);
  const a = getAnalysis(p.id, m.id);
  const minSilence = o.minSilence ?? 0.45;
  const pad = o.padding ?? 0.12;
  const from = Math.max(0, o.from ?? 0);
  const to = Math.min(m.duration, o.to ?? m.duration);
  let regions: { start: number; end: number }[] = [];
  const method = o.method ?? (a.words?.length ? "words" : "silence");
  if (method === "words") {
    if (!a.words?.length) throw new Error("no transcript for this media — use method 'silence'");
    const words = a.words.filter(
      (w) => w.end > from && w.start < to && !(o.removeFillers && FILLERS.has(w.text.toLowerCase().replace(/[^a-z]/g, ""))),
    );
    for (const w of words) {
      const last = regions[regions.length - 1];
      if (last && w.start - last.end <= minSilence) last.end = Math.max(last.end, w.end);
      else regions.push({ start: w.start, end: w.end });
    }
  } else {
    if (!a.silences) throw new Error("no silence analysis for this media");
    let cursor = from;
    for (const s of a.silences.filter((x) => x.end - x.start >= minSilence && x.end > from && x.start < to)) {
      if (s.start > cursor) regions.push({ start: cursor, end: s.start });
      cursor = Math.max(cursor, s.end);
    }
    if (cursor < to) regions.push({ start: cursor, end: to });
  }
  regions = regions
    .map((r) => ({ start: Math.max(from, r.start - pad), end: Math.min(to, r.end + pad) }))
    .filter((r) => r.end - r.start >= 0.25);
  const merged: { start: number; end: number }[] = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.02) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.map((r) => ({ start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000 }));
}

export function autoCut(p: Project, o: AutoCutOptions): EditResult & { removedSeconds?: number } {
  const m = p.media.find((x) => x.id === o.mediaId);
  if (!m) return { ok: false, errors: [`unknown mediaId ${o.mediaId}`], warnings: [], summary: summarize(p.spec) };
  let regions: { start: number; end: number }[];
  try {
    regions = autoCutRegions(p, o);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message], warnings: [], summary: summarize(p.spec) };
  }
  if (!regions.length) return { ok: false, errors: ["no speech found in that range"], warnings: [], summary: summarize(p.spec) };
  const clips: Clip[] = regions.map((r, i) => ({
    id: `cut${i + 1}`, mediaId: m.id, in: r.start, out: r.end, speed: 1, volume: 1, muted: false, flipX: false,
    ...(o.punchIn && i % 2 === 1 ? { motion: { type: "punch" as const, amount: 0.12 } } : {}),
  }));
  const r = applySpec(p, { ...raw(p), clips }, `auto-cut ${m.name}`);
  const kept = regions.reduce((s, x) => s + x.end - x.start, 0);
  return { ...r, removedSeconds: Math.round(((o.to ?? m.duration) - (o.from ?? 0) - kept) * 100) / 100 };
}

/** Replace one clip with a smooth speed ramp (see speedRampClips). */
export function speedRamp(p: Project, o: { clipId: string; peak?: number; shape?: "upDown" | "up" | "down"; segments?: number }): EditResult {
  const s = raw(p);
  const i = s.clips.findIndex((c) => c.id === o.clipId);
  if (i < 0) return { ok: false, errors: [`no clip "${o.clipId}"`], warnings: [], summary: summarize(p.spec) };
  const segs = speedRampClips(s.clips[i]!, o.peak ?? 2.5, o.shape ?? "upDown", Math.min(10, Math.max(3, Math.round(o.segments ?? 6))));
  s.clips.splice(i, 1, ...segs);
  return applySpec(p, s, `speed ramp ${o.clipId}`);
}

// ---------------------------------------------------------------- reading helpers for Claude

export function transcriptText(p: Project, opts: { mediaId?: string; timeline: "source" | "output"; words?: boolean; from?: number; to?: number }): string {
  const fmt = (t: number) => t.toFixed(2);
  type W = { text: string; start: number; end: number };
  let words: W[];
  if (opts.timeline === "output") {
    const analysis = Object.fromEntries(p.media.map((m) => [m.id, getAnalysis(p.id, m.id)]));
    words = mapWords(p.spec, analysis);
  } else {
    const m = p.media.find((x) => x.id === opts.mediaId) ?? p.media.find((x) => getAnalysis(p.id, x.id).words?.length);
    if (!m) return "No transcript available.";
    words = getAnalysis(p.id, m.id).words ?? [];
  }
  words = words.filter((w) => (opts.from === undefined || w.end >= opts.from) && (opts.to === undefined || w.start <= opts.to));
  if (!words.length) return "No words in that range.";
  if (opts.words) return words.map((w) => `${w.text}@${fmt(w.start)}-${fmt(w.end)}`).join(" ");
  const lines: string[] = [];
  let cur: W[] = [];
  const flush = () => {
    if (cur.length) lines.push(`[${fmt(cur[0]!.start)}-${fmt(cur[cur.length - 1]!.end)}] ${cur.map((w) => w.text).join(" ")}`);
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.6 || /[.!?؟]$/.test(prev.text) || cur.length >= 14)) flush();
    cur.push(w);
  }
  flush();
  return lines.join("\n");
}

export function projectContext(p: Project): string {
  const lines: string[] = [];
  lines.push(`Project "${p.name}" (id ${p.id}). Target platform: ${p.brief.platform} — canvas ${p.spec.format.width}x${p.spec.format.height} @ ${p.spec.format.fps}fps.`);
  if (p.brief.goal) lines.push(`Goal: ${p.brief.goal}`);
  if (p.brief.notes) lines.push(`Notes: ${p.brief.notes}`);
  for (const r of p.brief.references) lines.push(`Style reference (link NOT downloaded — use the user's description): ${r.url} — ${r.note || "no description"}`);
  lines.push("", "Media:");
  if (!p.media.length) lines.push("- (none yet — ask the user to upload their video)");
  for (const m of p.media) {
    const a = getAnalysis(p.id, m.id);
    const steps = Object.entries(m.steps).filter(([, s]) => s?.state !== "done" && s?.state !== "skipped").map(([k, s]) => `${k}:${s?.state}`);
    const faces = a.faces?.samples.length
      ? `${Math.round((100 * a.faces.samples.filter(Boolean).length) / a.faces.samples.length)}% of samples have a face`
      : "no face data";
    lines.push(
      `- ${m.id} "${m.name}" ${m.kind}` +
        (m.kind !== "audio" ? ` ${m.width}x${m.height}` : "") +
        (m.kind !== "image" ? ` ${m.duration.toFixed(2)}s` : "") +
        (m.kind === "video" ? ` ${m.fps}fps` : "") +
        ` audio:${m.hasAudio ? "yes" : "no"}` +
        (a.words ? ` | transcript ${a.words.length} words (${a.language ?? "?"})` : "") +
        (a.silences ? ` | ${a.silences.length} silences` : "") +
        (m.kind === "video" ? ` | ${faces}` : "") +
        (m.enhanced ? " | enhanced voice available" : "") +
        (m.fixed ? ` | footage FIXED (${Object.entries(m.fixed).filter(([k, v]) => v === true && k !== "at").map(([k]) => k).join(", ")})` : "") +
        (!m.fixed && a.look?.advice.notes.length ? ` | look: ${a.look.advice.notes.join(", ")}${autoFixOptions(a.look) ? " → fix_footage recommended" : ""}` : "") +
        (m.source.type === "stock" ? ` | stock (${m.source.license})` : m.source.type === "ai" ? " | AI image" : "") +
        (steps.length ? ` | still processing: ${steps.join(", ")}` : ""),
    );
  }
  const keys = keyStatus();
  lines.push(
    "",
    `Free visuals: stock photos yes (no key needed); stock videos ${keys.pexels ? "yes (Pexels key set)" : "NO — needs the user's free Pexels key"}; AI images yes${keys.huggingface || keys.pollinations ? "" : " (small watermark — no free token set)"}.`,
  );
  const credits = stockCredits(p);
  if (credits.length) lines.push(`Credits for the description: ${credits.join(" · ")}`);
  lines.push("", `Current edit: ${summarize(p.spec)}`, `Spec JSON: ${JSON.stringify(p.spec)}`);
  return lines.join("\n");
}

const b64 = (file: string) => readFileSync(file).toString("base64");

export async function sourceFrames(p: Project, mediaId: string, times: number[] | undefined, count = 6, width = 384) {
  const m = p.media.find((x) => x.id === mediaId);
  if (!m) throw new Error(`unknown mediaId ${mediaId}`);
  if (m.kind === "audio") throw new Error("audio has no frames");
  const src = path.join(mediaDir(p.id, m.id), m.kind === "image" ? m.original : (m.proxy ?? m.render ?? m.original));
  const base = m.kind === "image" ? [0] : times?.length ? times : Array.from({ length: count }, (_, i) => ((i + 0.5) * m.duration) / count);
  const ts = base.slice(0, 8).map((t) => (m.kind === "image" ? 0 : Math.max(0, Math.min(m.duration - 0.05, t))));
  const files = await grabFrames(src, ts, path.join(mediaDir(p.id, m.id), "frames"), width);
  return files.map((f, i) => ({ t: ts[i]!, base64: b64(f) }));
}

export async function previewStills(p: Project, times: number[] | undefined, count = 4, hookId?: string) {
  let spec = p.spec;
  if (hookId) {
    const hook = p.hooks?.find((h) => h.id === hookId);
    if (!hook) throw new Error(`no hook "${hookId}" — propose it first`);
    spec = applyHook(p.hookBase ?? p.spec, hook);
  }
  const total = totalSeconds(spec);
  const defaults = hookId ? [0.4, 1.2, 2.2, 3.5] : Array.from({ length: count }, (_, i) => ((i + 0.5) * total) / count);
  const ts = (times?.length ? times : defaults).slice(0, 6).filter((t) => t < total);
  // Proxies are plenty for 40%-scale review frames and far faster to fetch/decode than 4K originals.
  const props = { ...compositionProps(p, true), spec };
  const files = await renderStillsJob(props, ts, path.join(projectDir(p.id), "stills"), 0.4).done;
  return files.map((f, i) => ({ t: ts[i]!, base64: b64(f) }));
}

// ---------------------------------------------------------------- hooks (Night Shift proposals)

/** Validate and store hook proposals (replacing earlier ones). Each must apply cleanly to the current edit. */
export function proposeHooks(p: Project, input: unknown[]): { ok: boolean; saved: string[]; errors: string[] } {
  const base = p.hookBase ?? p.spec;
  const saved: StoredHook[] = [];
  const errors: string[] = [];
  input.slice(0, 8).forEach((raw, i) => {
    const parsed = HookSchema.safeParse(raw);
    if (!parsed.success) return void errors.push(`hook[${i}]: ${zodErrors(parsed.error).join("; ")}`);
    const hook = parsed.data;
    let applied: Spec;
    try {
      applied = applyHook(base, hook);
    } catch (e) {
      return void errors.push(`hook[${i}] "${hook.id}": doesn't apply — ${(e as Error).message.slice(0, 300)}`);
    }
    const check = semanticCheck(applied, p);
    if (check.errors.length) return void errors.push(`hook[${i}] "${hook.id}": ${check.errors.join("; ")}`);
    if (saved.some((h) => h.id === hook.id)) return void errors.push(`hook[${i}]: duplicate id "${hook.id}"`);
    saved.push({ ...hook, createdAt: now(), previewState: "pending" });
  });
  if (saved.length) {
    p.hooks = saved.sort((a, b) => b.score - a.score);
    saveProject(p);
  }
  return { ok: errors.length === 0 && saved.length > 0, saved: saved.map((h) => h.id), errors };
}

/** Put a hook into the edit. Always starts from the pre-hook edit, so choosing another hook swaps it. */
export function applyHookToProject(p: Project, hookId: string): EditResult {
  const hook = p.hooks?.find((h) => h.id === hookId);
  if (!hook) return { ok: false, errors: [`no hook "${hookId}"`], warnings: [], summary: summarize(p.spec) };
  const base = p.hookBase ?? p.spec;
  let next: Spec;
  try {
    next = applyHook(base, hook);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message], warnings: [], summary: summarize(p.spec) };
  }
  p.hookBase = base;
  for (const h of p.hooks ?? []) h.appliedAt = h.id === hookId ? now() : undefined;
  return applySpec(p, next, `hook: ${hook.title}`);
}

/** Remove whichever hook is applied, restoring the pre-hook edit. */
export function clearHook(p: Project): EditResult {
  if (!p.hookBase) return { ok: true, errors: [], warnings: ["no hook applied"], summary: summarize(p.spec) };
  const base = p.hookBase;
  p.hookBase = undefined;
  for (const h of p.hooks ?? []) h.appliedAt = undefined;
  return applySpec(p, base, "remove hook");
}

export { hookPreviewSeconds } from "../shared/hooks";

// ---------------------------------------------------------------- music library (for Claude)

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function musicSummary(t: Track) {
  return {
    trackId: t.id, title: t.title, artist: t.artist, genre: t.genre, moods: t.moods, bpm: t.bpm, duration: r3(t.duration),
    drops: t.drops.slice(0, 4), license: LICENSES[t.license], guideOnly: t.guideOnly,
    // a coarse loudness outline (every 4 s) so the shape of the song is visible at a glance
    energy: t.energy.filter((_, i) => i % 8 === 0).map((e) => Math.round(e * 10)),
  };
}

export function searchMusic(q: MusicQuery) {
  const all = searchTracks(q);
  return { count: all.length, tracks: all.slice(0, 15).map(musicSummary) };
}

/** Beat grid of a music layer in OUTPUT time (follows its start/offset/loops), optionally subdivided. */
export function beatsFor(p: Project, musicId: string, from = 0, to = Number.POSITIVE_INFINITY, subdivide = 1) {
  const mu = p.spec.audio.music.find((m) => m.id === musicId);
  if (!mu) throw new Error(`no music layer "${musicId}"`);
  const media = p.media.find((m) => m.id === mu.mediaId);
  const t = media?.libraryTrackId ? getTrack(media.libraryTrackId) : null;
  if (!t || !t.bpm) throw new Error("this music has no beat grid (only music-library tracks are analysed)");
  const end = Math.min(mu.end ?? totalSeconds(p.spec), totalSeconds(p.spec));
  const srcLen = Math.max(0.5, t.duration - mu.offset);
  const map = (list: number[]) => {
    const out: number[] = [];
    for (let i = 0; mu.start + i * srcLen < end; i++) {
      for (const b of list) {
        if (b < mu.offset) continue;
        const o = mu.start + i * srcLen + (b - mu.offset);
        if (o > end) break;
        if (o >= from && o <= to) out.push(o);
      }
      if (!mu.loop) break;
    }
    return out;
  };
  let beats = map(t.beats);
  if (subdivide > 1) {
    const sub: number[] = [];
    for (let i = 0; i < beats.length; i++) {
      const next = beats[i + 1] ?? beats[i]! + 60 / t.bpm;
      for (let k = 0; k < subdivide; k++) sub.push(beats[i]! + ((next - beats[i]!) * k) / subdivide);
    }
    beats = sub;
  }
  return { musicId, bpm: t.bpm, beats: beats.slice(0, 240).map(r3), drops: map(t.drops).map(r3) };
}

export function useMusic(
  p: Project,
  input: { trackId: string; id?: string; start?: number; end?: number; alignDropAt?: number; dropIndex?: number; volume?: number; duckTo?: number; fadeIn?: number; fadeOut?: number },
) {
  const t = getTrack(input.trackId);
  if (!t) return { ok: false, errors: [`no track "${input.trackId}" — use search_music first`], warnings: [], summary: summarize(p.spec) };
  const m = importTrack(p, t);
  let start = Math.max(0, input.start ?? 0);
  let offset = 0;
  if (input.alignDropAt !== undefined && t.drops.length) {
    // Line the track up so its drop hits exactly at alignDropAt (the payoff / the hook's reveal).
    const d = t.drops[Math.min(t.drops.length - 1, Math.max(0, input.dropIndex ?? 0))]!;
    offset = d - (input.alignDropAt - start);
    if (offset < 0) {
      start = input.alignDropAt - d;
      offset = 0;
    }
  }
  const id = input.id ?? `music${p.spec.audio.music.length + 1}`;
  const r = upsertLayers(p, {
    music: [{
      id, mediaId: m.id, start: r3(start), end: input.end, offset: r3(offset), volume: input.volume ?? 0.22, duckTo: input.duckTo ?? 0.3,
      fadeIn: input.fadeIn ?? 0.4, fadeOut: input.fadeOut ?? 1.5, loop: true, guide: t.guideOnly, title: t.title,
    }],
  }, `music: ${t.title}`);
  if (!r.ok) return r;
  if (t.guideOnly) r.warnings.push(`"${t.title}" is a GUIDE track: it times the edit in the preview but is NOT in the export — the creator adds it in the platform's music picker, starting at ${r3(offset)}s of the song.`);
  return { ...r, musicId: id, start: r3(start), offset: r3(offset), next20sBeats: beatsFor(p, id, start, start + 20).beats };
}

export async function makeMusic(style: string, bpm?: number, seconds?: number) {
  if (!(style in GEN_STYLES)) throw new Error(`style must be one of: ${Object.keys(GEN_STYLES).join(", ")}`);
  return musicSummary(await generateTrack(style as GenStyle, { bpm, seconds: Math.min(240, Math.max(20, seconds ?? 90)) }));
}

// ---------------------------------------------------------------- voiceovers (for Claude)

export async function generateVoiceover(
  p: Project,
  input: { text: string; voice?: string; speed?: number; addAt?: number; id?: string; captions?: boolean },
) {
  const text = (input.text ?? "").trim();
  if (!text) throw new Error("text is empty");
  if (text.length > 6000) throw new Error("too long for one voiceover — split the script into sections (≤ ~6000 characters each)");
  const voice = (input.voice && input.voice in VOICES ? input.voice : DEFAULT_VOICE) as VoiceId;
  const speed = Math.min(1.3, Math.max(0.7, input.speed ?? 1));
  const m = newMediaRecord(p.id, `Voiceover — ${text.slice(0, 50)}`, ".wav", { type: "upload" });
  m.kind = "audio";
  const out = path.join(mediaDir(p.id, m.id), m.original);
  const r = await synthesizeVoice(text, voice, speed, out);
  m.voice = { text: text.slice(0, 2000), voice, engine: r.engine };
  m.size = statSync(out).size;
  const fresh = getProject(p.id)!;
  fresh.media.push(m);
  saveProject(fresh);
  await enqueueIngest(fresh.id, m.id); // probe + word timings (captions follow the voice)
  const rec = getProject(p.id)!.media.find((x) => x.id === m.id)!;
  const words = getAnalysis(p.id, m.id).words?.length ?? 0;
  let layer: EditResult | undefined;
  if (input.addAt !== undefined) {
    const id = input.id ?? `vo${getProject(p.id)!.spec.audio.voice.length + 1}`;
    layer = upsertLayers(getProject(p.id)!, {
      voice: [{ id, mediaId: m.id, start: Math.max(0, input.addAt), offset: 0, end: r3(Math.max(0, input.addAt) + rec.duration), captions: input.captions ?? true }],
    }, "voiceover");
  }
  return { mediaId: m.id, duration: r3(rec.duration), engine: r.engine, voice, words, layer };
}

// ---------------------------------------------------------------- publish kit (for Claude)

/** Store the upload text (title, description, hashtags, chapters). Returns the full description to paste. */
export function setPublishInfo(p: Project, input: unknown): { ok: boolean; errors: string[]; warnings: string[]; text?: string } {
  const r = PublishSchema.safeParse(input);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`), warnings: [] };
  const info = { ...r.data, hashtags: [...new Set(r.data.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)))] };
  const warnings = chapterProblems(info.chapters, totalSeconds(p.spec));
  if (info.hashtags.length > 5) warnings.push("3-5 hashtags work best (TikTok/Shorts show only a few; YouTube ignores them all past 60)");
  if (info.title.length > 70) warnings.push("titles over ~70 characters get cut off on phones — front-load the hook");
  const fresh = getProject(p.id)!;
  fresh.publish = { ...info, updatedAt: now() };
  saveProject(fresh);
  return { ok: true, errors: [], warnings, text: publishText(info, stockCredits(fresh)) };
}

// ---------------------------------------------------------------- footage fixes (for Claude)

/**
 * Stabilize / denoise / exposure / white balance a video into a new render source. With no options it
 * applies the analysis' advice (white balance only for strong casts). Waits until the fix is done.
 */
export async function fixFootageForClaude(
  p: Project,
  input: { mediaId: string; stabilize?: boolean; denoise?: boolean; color?: boolean; whiteBalance?: boolean; sharpen?: boolean; undo?: boolean },
) {
  const m = p.media.find((x) => x.id === input.mediaId);
  if (!m || m.kind !== "video") throw new Error("mediaId must be a video in this project");
  if (input.undo) {
    await undoFix(p.id, m.id);
    return { ok: true, message: "Back to the original footage." };
  }
  const look = getAnalysis(p.id, m.id).look;
  if (!look) throw new Error("this video is still being analysed — try again in a moment");
  const explicit = ["stabilize", "denoise", "color", "whiteBalance", "sharpen"].some((k) => k in input);
  const opts = explicit
    ? { stabilize: !!input.stabilize, denoise: !!input.denoise, color: !!input.color, whiteBalance: !!input.whiteBalance, sharpen: !!input.sharpen }
    : autoFixOptions(look);
  if (!opts) return { ok: true, message: "Nothing to fix — the footage looks fine.", look: look.advice.notes };
  await fixMedia(p.id, m.id, opts);
  const after = getProject(p.id)?.media.find((x) => x.id === m.id);
  if (!after?.fixed) throw new Error(after?.steps.fix?.error ?? "the fix failed");
  const now2 = getAnalysis(p.id, m.id).look;
  return {
    ok: true,
    applied: Object.entries(opts).filter(([, v]) => v).map(([k]) => k),
    before: look.advice.notes,
    after: now2?.advice.notes ?? [],
    message: "Fixed footage is now used for preview and export. Face tracking was refreshed.",
  };
}

// ---------------------------------------------------------------- long video → clip ideas (Night Shift scout)

export function proposeClips(p: Project, input: unknown[]): { ok: boolean; saved: string[]; errors: string[] } {
  const errors: string[] = [];
  const ideas: ClipIdea[] = [];
  input.slice(0, 20).forEach((raw, i) => {
    const c = raw as Partial<ClipIdea>;
    const m = p.media.find((x) => x.id === c.mediaId);
    const where = `clips[${i}]${c.id ? ` "${c.id}"` : ""}`;
    if (!c.id || !/^[A-Za-z0-9_-]{1,40}$/.test(c.id)) return void errors.push(`${where}: id must be letters/digits/-/_`);
    if (!m || m.kind !== "video") return void errors.push(`${where}: mediaId must be a video in this project`);
    if (typeof c.in !== "number" || typeof c.out !== "number" || c.in < 0 || c.out > m.duration + 0.05 || c.out <= c.in) {
      return void errors.push(`${where}: in/out must be source seconds inside 0–${m.duration.toFixed(1)}`);
    }
    if (c.out - c.in < 8 || c.out - c.in > 180) return void errors.push(`${where}: a clip should be 8–180 s of source (got ${(c.out - c.in).toFixed(1)})`);
    if (ideas.some((x) => x.id === c.id)) return void errors.push(`${where}: duplicate id`);
    ideas.push({
      id: c.id, title: String(c.title ?? c.id).slice(0, 80), mediaId: m.id, in: r3(c.in), out: r3(Math.min(c.out, m.duration)),
      hook: String(c.hook ?? "").slice(0, 160), why: String(c.why ?? "").slice(0, 400), score: Math.min(10, Math.max(1, Number(c.score) || 5)),
    });
  });
  if (ideas.length) {
    p.clipPlan = ideas.sort((a, b) => b.score - a.score);
    saveProject(p);
  }
  return { ok: errors.length === 0 && ideas.length > 0, saved: ideas.map((x) => x.id), errors };
}
