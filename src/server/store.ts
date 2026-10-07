// On-disk project store: data/projects/<id>/project.json + media/<mid>/... + exports/ + history/.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CompositionProps, emptySpec, FORMAT_PRESETS, type MediaAnalysis, type MediaInfo, parseSpec, type Spec } from "../shared/spec";
import type { Hook } from "../shared/hooks";
import type { PublishInfo } from "../shared/publish";
import { emit } from "./bus";
import type { FixOptions, LookAnalysis } from "./look";
import { HOST, PORT, PROJECTS_DIR } from "./config";

export type StepName = "probe" | "proxy" | "audio" | "transcript" | "silences" | "faces" | "enhance" | "look" | "fix";
export type StepState = { state: "pending" | "running" | "done" | "error" | "skipped"; progress?: number; error?: string };

export type MediaRecord = {
  id: string;
  kind: MediaInfo["kind"];
  name: string;
  original: string; // file name inside media/<id>/
  render?: string; // file used for final renders (original, or a normalised copy)
  proxy?: string; // light H.264 for the browser preview
  enhanced?: string; // cleaned-up voice audio (m4a)
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  size: number;
  addedAt: string;
  source:
    | { type: "upload" }
    | { type: "url"; url: string; rightsConfirmed: true }
    | { type: "stock"; provider: string; url: string; license: string; creator?: string; title: string } // stock.ts
    | { type: "ai"; provider: string; prompt: string }; // AI image (stock.ts)
  libraryTrackId?: string; // came from the music library (beat grid / drops live there)
  voice?: { text: string; voice: string; engine: string }; // made by generate_voiceover
  // Footage fix (stabilize / denoise / exposure / white balance) baked into `render` = "fixed.mp4".
  fixed?: FixOptions & { at: string };
  fixedFrom?: string; // the render source the fix was made from (restored by "undo fix")
  // Short verdict for the UI (full numbers live in analysis.json → look).
  lookSummary?: { notes: string[]; fixable: boolean; tint: boolean };
  steps: Partial<Record<StepName, StepState>>;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  at: string; // ISO 8601
  tool?: { name: string; ok: boolean; summary?: string };
};

export type ClaudeState = {
  sessionId?: string;
  status: "idle" | "starting" | "working" | "needs_user" | "done" | "error";
  message?: string;
  options?: string[];
  model?: string;
  mode?: "interactive" | "autonomous"; // autonomous = Night Shift: never asks, decides everything itself
};

export type ExportRecord = { file: string; createdAt: string; preset: string; size: number; duration: number; label?: string };

export type StoredHook = Hook & {
  createdAt: string;
  preview?: string; // hooks/<id>.mp4 — short draft render of the opening with this hook
  previewState?: "pending" | "rendering" | "done" | "error";
  appliedAt?: string;
};

/** One short-form moment found inside a long video (source times of one media file). */
export type ClipIdea = {
  id: string;
  title: string;
  mediaId: string;
  in: number;
  out: number;
  hook: string; // the opening line / angle that makes it stop the scroll
  why: string;
  score: number; // 1-10 expected performance
};

export type Brief = {
  platform: "youtube" | "short" | "square" | "portrait";
  goal: string;
  notes: string;
  references: { url: string; note: string }[]; // style references only — never downloaded
};

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  brief: Brief;
  media: MediaRecord[];
  spec: Spec;
  claude: ClaudeState;
  chat: ChatMessage[];
  exports: ExportRecord[];
  hooks?: StoredHook[]; // proposals waiting for the creator's decision
  hookBase?: Spec; // the edit before any hook was applied (so hooks swap instead of stacking)
  clipPlan?: ClipIdea[]; // long video → shorts: the moments Claude picked (Night Shift "clips" mode)
  night?: { batchId: string; summary?: string }; // set when Night Shift made this project
  publish?: PublishInfo & { updatedAt: string }; // title / description / hashtags / chapters (set_publish_info)
  thumbnails?: ThumbRecord[]; // made by make_thumbnails, newest first (files in thumbnails/)
};

export type ThumbRecord = { file: string; text: string; mediaId: string; t: number; createdAt: string };

export type Silence = { start: number; end: number };
export type FullAnalysis = MediaAnalysis & { silences?: Silence[]; look?: LookAnalysis };

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
export const now = () => new Date().toISOString();
export const projectDir = (id: string) => path.join(PROJECTS_DIR, id);
export const mediaDir = (id: string, mid: string) => path.join(projectDir(id), "media", mid);
const projectFile = (id: string) => path.join(projectDir(id), "project.json");
const analysisFile = (id: string, mid: string) => path.join(mediaDir(id, mid), "analysis.json");

const ID_RE = /^[a-z0-9]{6,32}$/;
export const validId = (id: string) => ID_RE.test(id);

function writeJsonAtomic(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, file);
}

export function listProjects(): Pick<Project, "id" | "name" | "updatedAt" | "brief">[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out: Pick<Project, "id" | "name" | "updatedAt" | "brief">[] = [];
  for (const id of readdirSync(PROJECTS_DIR)) {
    try {
      const p = getProject(id);
      if (p) out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, brief: p.brief });
    } catch {
      // skip unreadable projects
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createProject(name: string, platform: Brief["platform"]): Project {
  const id = newId();
  const spec = emptySpec(platform);
  const p: Project = {
    id,
    name: name.trim().slice(0, 80) || "Untitled video",
    createdAt: now(),
    updatedAt: now(),
    brief: { platform, goal: "", notes: "", references: [] },
    media: [],
    spec,
    claude: { status: "idle" },
    chat: [],
    exports: [],
  };
  saveProject(p);
  return p;
}

const cache = new Map<string, Project>();

export function getProject(id: string): Project | null {
  if (!validId(id)) return null;
  const hit = cache.get(id);
  if (hit) return hit;
  const f = projectFile(id);
  if (!existsSync(f)) return null;
  const raw = JSON.parse(readFileSync(f, "utf8")) as Project;
  raw.spec = parseSpec(raw.spec); // re-apply defaults if the schema grew
  cache.set(id, raw);
  return raw;
}

export function saveProject(p: Project, notify = true) {
  p.updatedAt = now();
  cache.set(p.id, p);
  writeJsonAtomic(projectFile(p.id), p);
  if (notify) emit({ type: "project", projectId: p.id });
}

export function deleteProject(id: string) {
  if (!validId(id)) return;
  cache.delete(id);
  rmSync(projectDir(id), { recursive: true, force: true });
}

/** A fresh media record (not yet in the project). The caller puts the file at mediaDir(projectId, m.id)/m.original. */
export function newMediaRecord(projectId: string, name: string, ext: string, source: MediaRecord["source"]): MediaRecord {
  const m: MediaRecord = {
    id: newId(), kind: "video", name: name.slice(0, 120), original: `original${ext.toLowerCase()}`,
    width: 0, height: 0, duration: 0, fps: 0, hasAudio: false, size: 0, addedAt: now(), source, steps: { probe: { state: "pending" } },
  };
  mkdirSync(mediaDir(projectId, m.id), { recursive: true });
  return m;
}

export function updateMedia(projectId: string, mid: string, fn: (m: MediaRecord) => void) {
  const p = getProject(projectId);
  const m = p?.media.find((x) => x.id === mid);
  if (!p || !m) return;
  fn(m);
  saveProject(p);
}

export function setStep(projectId: string, mid: string, step: StepName, s: StepState) {
  updateMedia(projectId, mid, (m) => {
    m.steps[step] = s;
  });
}

export function getAnalysis(projectId: string, mid: string): FullAnalysis {
  const f = analysisFile(projectId, mid);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as FullAnalysis) : {};
}

export function patchAnalysis(projectId: string, mid: string, patch: Partial<FullAnalysis>) {
  const merged = { ...getAnalysis(projectId, mid), ...patch };
  writeJsonAtomic(analysisFile(projectId, mid), merged);
}

// ---------------------------------------------------------------- spec + undo history

const historyDir = (id: string) => path.join(projectDir(id), "history");
const MAX_HISTORY = 60;

export function setSpec(projectId: string, spec: Spec, reason: string) {
  const p = getProject(projectId);
  if (!p) throw new Error("project not found");
  const dir = historyDir(projectId);
  mkdirSync(dir, { recursive: true });
  const entries = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const next = String(entries.length ? Number(entries[entries.length - 1]!.slice(0, 6)) + 1 : 1).padStart(6, "0");
  writeJsonAtomic(path.join(dir, `${next}.json`), { reason, at: now(), spec: p.spec });
  for (const old of entries.slice(0, Math.max(0, entries.length + 1 - MAX_HISTORY))) rmSync(path.join(dir, old), { force: true });
  p.spec = spec;
  saveProject(p);
  emit({ type: "spec", projectId, reason });
}

/** Restore the previous spec. Returns false when there is nothing to undo. */
export function undoSpec(projectId: string): boolean {
  const p = getProject(projectId);
  const dir = historyDir(projectId);
  if (!p || !existsSync(dir)) return false;
  const entries = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const last = entries[entries.length - 1];
  if (!last) return false;
  const { spec } = JSON.parse(readFileSync(path.join(dir, last), "utf8")) as { spec: Spec };
  rmSync(path.join(dir, last), { force: true });
  p.spec = parseSpec(spec);
  saveProject(p);
  emit({ type: "spec", projectId, reason: "undo" });
  return true;
}

// ---------------------------------------------------------------- composition props

export const baseUrl = () => `http://${HOST}:${PORT}`;
export const fileUrl = (projectId: string, rel: string) =>
  `${baseUrl()}/files/${projectId}/${rel.split(path.sep).join("/")}`;

export function compositionProps(p: Project, preview: boolean): CompositionProps {
  const media: Record<string, MediaInfo> = {};
  const analysis: CompositionProps["analysis"] = {};
  for (const m of p.media) {
    if (!m.steps.probe || m.steps.probe.state !== "done") continue;
    const rel = (f: string) => fileUrl(p.id, `media/${m.id}/${f}`);
    media[m.id] = {
      id: m.id,
      kind: m.kind,
      name: m.name,
      src: rel(m.render ?? m.original),
      previewSrc: m.proxy ? rel(m.proxy) : undefined,
      enhancedSrc: m.enhanced ? rel(m.enhanced) : undefined,
      width: m.width,
      height: m.height,
      duration: m.duration,
      fps: m.fps,
      hasAudio: m.hasAudio,
    };
    const a = getAnalysis(p.id, m.id);
    analysis[m.id] = { words: a.words, faces: a.faces, language: a.language };
  }
  return { spec: p.spec, media, analysis, preview, sfxBaseUrl: `${baseUrl()}/sfx` };
}

export function formatFor(platform: Brief["platform"]) {
  return FORMAT_PRESETS[platform];
}
