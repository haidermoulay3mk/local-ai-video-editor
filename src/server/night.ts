// Night Shift: hand it your clips and go to sleep. Each video is analysed, edited by Claude on its own
// (it never waits for answers), exported, and given ranked hook ideas with short preview renders —
// all waiting for your decision in the morning. One shift runs at a time; it survives app restarts.
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import { runAutonomous, stopClaude } from "../claude/bridge";
import { applyHook, hookPreviewSeconds } from "../shared/hooks";
import { FORMAT_PRESETS } from "../shared/spec";
import { emit, NIGHT_CHANNEL } from "./bus";
import { DATA_DIR } from "./config";
import { applySpec, autoCutRegions, type EditResult, useMusic } from "./editor";
import { searchTracks } from "./music";
import { enqueueIngest, fixMedia } from "./ingest";
import { autoFixOptions } from "./look";
import { cancelRenders, queueExport, queueHookPreview } from "./renders";
import {
  type Brief, type ClipIdea, createProject, getAnalysis, getProject, type MediaRecord, mediaDir, newId, newMediaRecord, now, type Project,
  saveProject,
} from "./store";

const NIGHT_DIR = path.join(DATA_DIR, "night");
const SEEN_FILE = path.join(NIGHT_DIR, "inbox-seen.json");
/** Drop clips here (Explorer, phone sync…) and tick "Use the inbox folder": new ones are copied in when the shift starts. */
export const INBOX_DIR = path.join(process.env.USERPROFILE ?? DATA_DIR, "Videos", "Video Editor Inbox");
export const NIGHT_VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

const CLAUDE_TIMEOUT = 75 * 60_000; // one video's edit (previews render on this PC, so be generous)
const MAX_LIMIT_WAIT = 10 * 3600_000; // a usage reset further away than this (weekly cap) → finish the night without Claude
const SHORT_MAX_SECONDS = 180; // auto format: up to 3 min → vertical Short/Reel, longer → YouTube 16:9

export type NightSettings = {
  format: "auto" | Brief["platform"];
  // separate: one video per file · combine: every file into one video ·
  // clips: each (long) video → several shorts · longform: one long video from clips and/or a script
  mode: "separate" | "combine" | "clips" | "longform";
  instructions: string; // standing notes for Claude ("fast pace, yellow captions, no music")
  model: "sonnet" | "opus" | "haiku";
  hooks: number; // hook ideas per video (3-5)
  keepAwake: boolean;
  useInbox: boolean;
  startAt?: string; // ISO; unset = start right away
  clipCount?: number; // clips mode: shorts per long video (3-15)
  script?: string; // longform: what the voiceover says (optional)
  reference?: string; // longform: a video whose style to follow (link only — never downloaded)
  voice?: string; // longform voiceover voice
  music?: "auto" | "none";
  autoFix?: boolean; // stabilize / denoise / fix exposure where the analysis says so (default on)
};
export type NightFile = { name: string; size: number; addedAt: string };
export type NightItem = {
  id: string;
  name: string;
  files: string[];
  projectId?: string;
  kind?: "edit" | "scout" | "clip"; // scout = find the best moments of a long video; clip = one of those moments
  clip?: { sourceProjectId: string; mediaId: string; in: number; out: number; hook: string; why: string; score: number };
  state: "waiting" | "ingesting" | "editing" | "rendering" | "done" | "error" | "cancelled";
  step?: string;
  error?: string;
  edit?: "claude" | "partial" | "fallback"; // who made the edit
  exportFile?: string;
  hooks?: number;
  startedAt?: string;
  finishedAt?: string;
};
export type NightBatch = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  state: "draft" | "scheduled" | "queued" | "running" | "waiting_limit" | "done" | "cancelled";
  settings: NightSettings;
  files: NightFile[]; // waiting in incoming/ until the shift starts (size 0 = still uploading)
  items: NightItem[]; // planned when the shift starts
  resumeAt?: string; // set while waiting for Claude's usage limit to reset
  claudeOffUntil?: string; // usage reset too far away — the rest of the night uses the automatic edit
  startedAt?: string;
  finishedAt?: string;
  log: { at: string; text: string }[];
};

const batchFile = (id: string) => path.join(NIGHT_DIR, `${id}.json`);
export const incomingDir = (id: string) => path.join(NIGHT_DIR, id, "incoming");
const batches = new Map<string, NightBatch>();
let active: { id: string; abort: AbortController; projectId?: string } | null = null;
const LIVE = new Set<NightBatch["state"]>(["scheduled", "queued", "running", "waiting_limit"]);
const FINISHED = new Set<NightItem["state"]>(["done", "error", "cancelled"]);

const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function save(b: NightBatch) {
  b.updatedAt = now();
  batches.set(b.id, b);
  mkdirSync(NIGHT_DIR, { recursive: true });
  const f = batchFile(b.id);
  writeFileSync(`${f}.tmp`, JSON.stringify(b, null, 1));
  renameSync(`${f}.tmp`, f);
  emit({ type: "night", projectId: NIGHT_CHANNEL, batchId: b.id });
}

function log(b: NightBatch, text: string) {
  b.log.push({ at: now(), text });
  if (b.log.length > 300) b.log.splice(0, b.log.length - 300);
  console.log(`  [night] ${text}`);
  save(b);
}

export const listBatches = () => [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const getBatch = (id: string) => batches.get(id) ?? null;
const editable = (b: NightBatch) => b.state === "draft" || b.state === "scheduled" || b.state === "queued";
function assertEditable(b: NightBatch) {
  if (!editable(b)) throw new Error("This night shift has already started.");
}

export function createBatch(): NightBatch {
  const b: NightBatch = {
    id: newId(),
    name: `Night of ${new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`,
    createdAt: now(), updatedAt: now(), state: "draft",
    settings: {
      format: "auto", mode: "separate", instructions: "", model: "sonnet", hooks: 4, keepAwake: true, useInbox: false,
      clipCount: 10, script: "", reference: "", voice: "am_michael", music: "auto", autoFix: true,
    },
    files: [], items: [], log: [],
  };
  mkdirSync(incomingDir(b.id), { recursive: true });
  save(b);
  return b;
}

export function patchBatch(b: NightBatch, patch: { name?: string; settings?: Partial<NightSettings> }): NightBatch {
  assertEditable(b);
  if (typeof patch.name === "string" && patch.name.trim()) b.name = patch.name.trim().slice(0, 80);
  const s = patch.settings ?? {};
  const cur = b.settings;
  if (s.format && (["auto", "youtube", "short", "square", "portrait"] as const).includes(s.format)) cur.format = s.format;
  if (s.mode && (["separate", "combine", "clips", "longform"] as const).includes(s.mode)) cur.mode = s.mode;
  if (typeof s.clipCount === "number" && Number.isFinite(s.clipCount)) cur.clipCount = Math.min(15, Math.max(1, Math.round(s.clipCount)));
  if (typeof s.script === "string") cur.script = s.script.slice(0, 30000);
  if (typeof s.reference === "string") cur.reference = s.reference.trim().slice(0, 500);
  if (typeof s.voice === "string") cur.voice = s.voice.slice(0, 40);
  if (s.music === "auto" || s.music === "none") cur.music = s.music;
  if (typeof s.instructions === "string") cur.instructions = s.instructions.slice(0, 2000);
  if (s.model && (["sonnet", "opus", "haiku"] as const).includes(s.model)) cur.model = s.model;
  if (typeof s.hooks === "number" && Number.isFinite(s.hooks)) cur.hooks = Math.min(5, Math.max(3, Math.round(s.hooks)));
  if (typeof s.keepAwake === "boolean") cur.keepAwake = s.keepAwake;
  if (typeof s.useInbox === "boolean") cur.useInbox = s.useInbox;
  if (typeof s.autoFix === "boolean") cur.autoFix = s.autoFix;
  save(b);
  updateKeepAwake();
  return b;
}

export function deleteBatch(b: NightBatch) {
  if (active?.id === b.id) throw new Error("Cancel the night shift first.");
  batches.delete(b.id);
  rmSync(batchFile(b.id), { force: true });
  rmSync(path.join(NIGHT_DIR, b.id), { recursive: true, force: true }); // only un-started uploads; projects stay
  updateKeepAwake();
}

// ---------------------------------------------------------------- incoming clips

/** Reserve a file name for an upload (null = not a video). Call finishIncoming / removeIncoming afterwards. */
export function reserveIncoming(b: NightBatch, name: string): { name: string; file: string } | null {
  assertEditable(b);
  const base = path.basename(name).replace(/[^\w.\- ()[\]]+/g, "_").slice(-120);
  if (!NIGHT_VIDEO.test(base)) return null;
  const ext = path.extname(base);
  const stem = base.slice(0, -ext.length) || "clip";
  let candidate = base;
  for (let i = 2; b.files.some((f) => f.name === candidate) || existsSync(path.join(incomingDir(b.id), candidate)); i++) {
    candidate = `${stem} (${i})${ext}`;
  }
  mkdirSync(incomingDir(b.id), { recursive: true });
  b.files.push({ name: candidate, size: 0, addedAt: now() });
  save(b);
  return { name: candidate, file: path.join(incomingDir(b.id), candidate) };
}

export function finishIncoming(b: NightBatch, name: string, size: number) {
  const f = b.files.find((x) => x.name === name);
  if (f) f.size = size;
  save(b);
}

export function removeIncoming(b: NightBatch, name: string) {
  assertEditable(b);
  b.files = b.files.filter((f) => f.name !== name);
  rmSync(path.join(incomingDir(b.id), path.basename(name)), { force: true });
  save(b);
}

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

/** Videos in the inbox folder that were never imported before. */
export function inboxNew(): { name: string; size: number; full: string; key: string }[] {
  if (!existsSync(INBOX_DIR)) return [];
  const seen = readSeen();
  const out: { name: string; size: number; full: string; key: string }[] = [];
  for (const name of readdirSync(INBOX_DIR)) {
    if (!NIGHT_VIDEO.test(name)) continue;
    const full = path.join(INBOX_DIR, name);
    try {
      const st = statSync(full);
      const key = `${name}|${st.size}|${Math.round(st.mtimeMs)}`;
      if (st.isFile() && st.size > 0 && !seen.has(key)) out.push({ name, size: st.size, full, key });
    } catch {
      // locked or vanished mid-scan
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Copy new inbox videos into the shift (the originals stay in the inbox). */
export async function importInbox(b: NightBatch): Promise<number> {
  const seen = readSeen();
  let n = 0;
  for (const f of inboxNew()) {
    const t = reserveIncoming(b, f.name);
    if (!t) continue;
    try {
      await Bun.write(t.file, Bun.file(f.full));
      finishIncoming(b, t.name, statSync(t.file).size);
      seen.add(f.key);
      n++;
    } catch (e) {
      removeIncoming(b, t.name);
      log(b, `Couldn't copy ${f.name} from the inbox: ${(e as Error).message}`);
    }
  }
  mkdirSync(NIGHT_DIR, { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
  if (n) log(b, `Copied ${plural(n, "new clip")} from the inbox folder.`);
  return n;
}

export function openInbox() {
  mkdirSync(INBOX_DIR, { recursive: true });
  Bun.spawn(["explorer.exe", INBOX_DIR], { stdout: "ignore", stderr: "ignore" });
}

// ---------------------------------------------------------------- start / cancel / schedule

export function startBatch(b: NightBatch, startAt?: string) {
  assertEditable(b);
  if (b.files.some((f) => f.size === 0)) throw new Error("Wait for the uploads to finish first.");
  const scriptOnly = b.settings.mode === "longform" && !!b.settings.script?.trim();
  if (!b.files.length && !b.settings.useInbox && !scriptOnly) throw new Error("Add some clips first (or use the inbox folder, or write a script).");
  const at = startAt ? Date.parse(startAt) : Number.NaN;
  if (Number.isFinite(at) && at > Date.now() + 30_000) {
    b.settings.startAt = new Date(at).toISOString();
    b.state = "scheduled";
    log(b, `Scheduled to start at ${clock(at)}.`);
  } else {
    b.settings.startAt = undefined;
    b.state = "queued";
    log(b, active ? "Queued — starts when the current night shift finishes." : "Starting…");
  }
  updateKeepAwake();
  void tick();
}

export function cancelBatch(b: NightBatch) {
  if (!LIVE.has(b.state)) return;
  if (active?.id === b.id) {
    active.abort.abort(); // the runner marks the shift cancelled when it unwinds
    if (active.projectId) {
      stopClaude(active.projectId);
      cancelRenders(active.projectId);
    }
    log(b, "Cancelling…");
  } else {
    b.state = "draft";
    b.settings.startAt = undefined;
    log(b, "Cancelled before it started — you can change it and start again.");
  }
  updateKeepAwake();
}

let ticking = false;
async function tick() {
  if (active || ticking) return;
  ticking = true;
  try {
    const due = listBatches().reverse().find(
      (b) => b.state === "queued" || (b.state === "scheduled" && Date.parse(b.settings.startAt ?? "") <= Date.now()),
    );
    if (due) void runBatch(due);
    updateKeepAwake();
  } finally {
    ticking = false;
  }
}

/** Load saved shifts, resume one the app was closed in the middle of, and start the scheduler. */
export function initNight() {
  mkdirSync(NIGHT_DIR, { recursive: true });
  for (const f of readdirSync(NIGHT_DIR)) {
    if (!f.endsWith(".json") || f === path.basename(SEEN_FILE)) continue;
    try {
      const b = JSON.parse(readFileSync(path.join(NIGHT_DIR, f), "utf8")) as NightBatch;
      if (b.state === "running" || b.state === "waiting_limit") {
        b.state = "queued";
        b.resumeAt = undefined;
        for (const it of b.items) if (!FINISHED.has(it.state)) it.state = "waiting";
        b.log.push({ at: now(), text: "The app restarted — resuming the night shift." });
      }
      batches.set(b.id, b);
    } catch {
      // unreadable shift file: ignore
    }
  }
  setInterval(() => void tick(), 20_000);
  void tick();
}

export function stopNight() {
  if (active) active.abort.abort();
  awake?.kill();
  awake = null;
}

// ---------------------------------------------------------------- keep the PC awake

let awake: Subprocess | null = null;
function updateKeepAwake() {
  const want = process.platform === "win32" && listBatches().some((b) => LIVE.has(b.state) && b.settings.keepAwake);
  if (want && !awake) {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED (0x80000001): no idle sleep while this helper lives (the screen may still
    // turn off). It exits by itself when the Video Editor process is gone, so it can't keep the PC awake forever.
    const ps = `$k = Add-Type -Name Power -Namespace VideoEditor -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void]$k::SetThreadExecutionState([uint32]2147483649); while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`;
    awake = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { stdout: "ignore", stderr: "ignore", windowsHide: true });
  } else if (!want && awake) {
    awake.kill();
    awake = null;
  }
}
export const keepingAwake = () => !!awake;

// ---------------------------------------------------------------- the runner

function planItems(b: NightBatch): NightItem[] {
  const files = b.files.filter((f) => f.size > 0).map((f) => f.name);
  const title = (f: string) => path.basename(f, path.extname(f)).replace(/[_]+/g, " ").trim().slice(0, 70) || "Clip";
  const mode = b.settings.mode;
  if (mode === "longform") {
    return files.length || b.settings.script?.trim() ? [{ id: newId(), name: b.name, files, kind: "edit", state: "waiting" }] : [];
  }
  if (mode === "clips") {
    // Each long video is scouted first; its shorts are added to the list once the best moments are found.
    return files.map((f) => ({ id: newId(), name: `${title(f)} — finding the best moments`, files: [f], kind: "scout" as const, state: "waiting" as const }));
  }
  if (mode === "combine" && files.length > 1) return [{ id: newId(), name: b.name, files, kind: "edit", state: "waiting" }];
  return files.map((f) => ({ id: newId(), name: title(f), files: [f], kind: "edit" as const, state: "waiting" as const }));
}

async function runBatch(b: NightBatch) {
  const abort = new AbortController();
  active = { id: b.id, abort };
  try {
    if (!b.items.length) {
      if (b.settings.useInbox) await importInbox(b);
      b.items = planItems(b);
    }
    b.state = "running";
    b.startedAt ??= now();
    b.settings.startAt = undefined;
    if (!b.items.length) {
      log(b, "Nothing to edit — no clips were added and the inbox folder had nothing new.");
      return;
    }
    log(b, b.settings.mode === "clips"
      ? `Night shift started: finding the best moments in ${plural(b.items.length, "long video")}.`
      : `Night shift started: ${plural(b.items.length, "video")} to make.`);
    updateKeepAwake();
    // Index loop: scouting a long video inserts its clips right after it.
    for (let i = 0; i < b.items.length; i++) {
      if (abort.signal.aborted) break;
      const item = b.items[i]!;
      if (FINISHED.has(item.state)) continue;
      await runItem(b, item, abort.signal);
    }
  } catch (e) {
    log(b, `Night shift stopped early: ${(e as Error).message}`);
  } finally {
    b.resumeAt = undefined;
    b.finishedAt = now();
    if (abort.signal.aborted) {
      b.state = "cancelled";
      for (const it of b.items) {
        if (!FINISHED.has(it.state)) {
          it.state = "cancelled";
          it.step = undefined;
        }
      }
      log(b, "Night shift cancelled.");
    } else {
      b.state = "done";
      const videos = b.items.filter((i) => i.kind !== "scout");
      const ready = videos.filter((i) => i.state === "done");
      const hooks = ready.reduce((s, i) => s + (i.hooks ?? 0), 0);
      const failed = videos.length - ready.length;
      log(b, `Finished: ${ready.length} of ${plural(videos.length, "video")} ready${hooks ? `, ${plural(hooks, "hook idea")} waiting for you` : ""}${failed ? ` · ${failed} had problems` : ""}.`);
    }
    active = null;
    updateKeepAwake();
    void tick();
  }
}

function step(b: NightBatch, item: NightItem, state: NightItem["state"], text: string) {
  item.state = state;
  item.step = text;
  save(b);
}

const unfinished = (m: MediaRecord) =>
  !m.steps.probe || Object.values(m.steps).some((s) => s?.state === "pending" || s?.state === "running");

function moveFile(src: string, dest: string) {
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    rmSync(src, { force: true });
  }
}

function autoPlatform(videos: MediaRecord[]): Brief["platform"] {
  const total = videos.reduce((s, m) => s + m.duration, 0);
  const vertical = videos.every((m) => m.height > m.width);
  return vertical || total <= SHORT_MAX_SECONDS ? "short" : "youtube";
}

const PLATFORM_LABEL: Record<Brief["platform"], string> = {
  youtube: "YouTube video (16:9, 1920x1080)",
  short: "vertical Short / Reel / TikTok (9:16, 1080x1920)",
  square: "square post (1:1, 1080x1080)",
  portrait: "Instagram feed post (4:5, 1080x1350)",
};

const MUSIC_LINE =
  "Music: pick from the creator's library with search_music to fit the mood — phonk/trap for bold, hype or dark energy; cinematic for inspiring or emotional; upbeat for fun; lo-fi for calm. If nothing fits, generate_music. use_music with alignDropAt on the payoff (or the hook's reveal) and cut, zoom and add SFX ON the beats (get_beats). Under speech keep it ~0.15-0.25 (it ducks automatically). Never invent a song the library doesn't have.";

/** Library tracks the shift's other videos already use, so a set of shorts doesn't all share one song. */
function tracksUsedBySiblings(b: NightBatch, item: NightItem): string[] {
  const names = new Set<string>();
  for (const it of b.items) {
    if (it === item || it.kind === "scout" || !it.projectId) continue;
    const p = getProject(it.projectId);
    for (const m of p?.spec.audio.music ?? []) {
      const rec = p!.media.find((x) => x.id === m.mediaId);
      if (rec?.libraryTrackId) names.add(m.title ?? rec.name);
    }
  }
  return [...names];
}

/** What Claude is asked to do, per kind of job. `reference` is the style link's title/author if known. */
function taskText(b: NightBatch, item: NightItem, platform: Brief["platform"], reference?: string): string {
  const n = item.files.length;
  const s = b.settings;
  const notes = s.instructions.trim();
  const used = s.music === "none" ? [] : tracksUsedBySiblings(b, item);
  const music = s.music === "none"
    ? "No music tonight (the creator turned it off)."
    : MUSIC_LINE + (used.length ? ` Tonight's other videos already use ${used.map((t) => `"${t}"`).join(", ")} — pick a different track when another one fits the mood, so the set doesn't all sound the same.` : "");
  const close = `Propose ${s.hooks} hooks. Nobody will answer questions tonight: decide everything yourself, self-review, then set_status "done".`;
  const standing = notes ? `The creator's standing instructions (follow them): ${notes}` : "No special instructions — use your best judgement for this platform.";
  if (item.kind === "clip" && item.clip) {
    const c = item.clip;
    return [
      `NIGHT SHIFT CLIP — "${item.name}". Make a finished ${PLATFORM_LABEL[platform]} from ONE moment of a longer video.`,
      `Use ONLY media ${c.mediaId} between source ${c.in.toFixed(1)}s and ${c.out.toFixed(1)}s (trim tighter, drop weak lines; never use footage outside this range — other clips cover the rest). Start with auto_cut using from/to.`,
      `The scout's angle: ${c.hook} — ${c.why}`,
      "Aim for 15-60 seconds; it must make sense on its own (no 'as I said earlier'). Strong first second, clear payoff, punchy captions. Title, hook and graphics are about THIS moment only.",
      music,
      standing,
      close,
    ].join("\n");
  }
  if (s.mode === "longform") {
    const script = s.script?.trim();
    return [
      `NIGHT SHIFT LONG-FORM — "${item.name}". Make an engaging, polished ${PLATFORM_LABEL[platform]}.`,
      script
        ? `SCRIPT — the voiceover must say exactly this, in this order. Split it into sections and call generate_voiceover once per section (voice "${s.voice || "am_michael"}"), placing each with addAt right after the previous one:\n<<<\n${script.slice(0, 20000)}\n>>>`
        : "",
      n
        ? `The creator's footage (${plural(n, "clip")}, see get_project) is your visuals: ${script ? "match shots to what the voice is saying — as clips (mute their audio where the voiceover plays) or video overlays (B-roll)." : "build the story with set_clips across the media ids, in the order that works best."}`
        : "There is no footage: build the visuals from title cards, keyword slams, lists, quotes, counters, shapes and kinetic text over strong background colours. The screen must never sit empty while the voice talks: as one graphic ends the next begins (gaps under 0.5 s, except the first ~3 s kept for the hook), and the visual changes every 2-4 s.",
      reference ? `Style reference: ${reference}. You can't watch it — match the conventions of that kind of video (pacing, structure, tone).` : "",
      "Structure: a hook in the first 5-10 s, chapter title cards between sections, a pattern interrupt (zoom, SFX, graphic or music change) every 20-40 s, a clear payoff and a short call to action at the end.",
      n
        ? "Captions on (a cleaner, smaller style for 16:9)."
        : "Captions are part of the visuals here: a bold style, size 72-96, clear of the graphics — never the small minimal style over an empty background.",
      music,
      standing,
      close,
    ].filter(Boolean).join("\n");
  }
  return [
    `NIGHT SHIFT JOB — "${item.name}". Make a finished ${PLATFORM_LABEL[platform]}.`,
    n > 1 ? `There are ${n} clips: combine them into ONE video, in the order that tells the best story (the file order is only a hint). Build the sequence with set_clips across the media ids.` : "",
    platform === "short"
      ? "Aim for roughly 20-60 seconds unless the content clearly needs longer (hard maximum 3 minutes)."
      : "Keep every part that adds value; cut dead air, repeats and rambling.",
    music,
    standing,
    close,
  ].filter(Boolean).join("\n");
}

function scoutText(b: NightBatch, item: NightItem): string {
  const count = b.settings.clipCount ?? 10;
  return [
    `NIGHT SHIFT SCOUT — "${item.name}". Do NOT edit anything. Find the ${count} best moments in this long video for vertical shorts.`,
    "Read the whole transcript (get_transcript, timeline \"source\"), look at a few frames, then call propose_clips with up to " + `${count} clips (SOURCE seconds of the media, 15-60 s of usable speech each, starting and ending on sentence boundaries).`,
    "A great clip: a strong first line, ONE self-contained idea, a payoff (insight, twist, laugh, emotion, bold claim) and no dependence on earlier context. A complete idea under 15 s beats padding it with an unrelated one; join two ideas only when they form one arc (problem → fix) and the title covers both. Prefer variety; avoid overlaps.",
    b.settings.instructions.trim() ? `The creator's standing instructions: ${b.settings.instructions.trim()}` : "",
    'Then set_status "done" with one line per clip. Nobody will answer questions tonight.',
  ].filter(Boolean).join("\n");
}

/** Without Claude: pick clips from the transcript — sentence-aligned windows with the densest speech. */
export function heuristicClips(p: Project, mediaId: string, count: number): ClipIdea[] {
  const words = getAnalysis(p.id, mediaId).words ?? [];
  if (!words.length) return [];
  const sentences: { start: number; end: number; text: string }[] = [];
  let cur: typeof words = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (/[.!?]$/.test(w.text) || !next || next.start - w.end > 0.8) {
      sentences.push({ start: cur[0]!.start, end: w.end, text: cur.map((x) => x.text).join(" ") });
      cur = [];
    }
  });
  const windows: (ClipIdea & { density: number })[] = [];
  for (let i = 0; i < sentences.length; i++) {
    let j = i;
    while (j < sentences.length - 1 && sentences[j]!.end - sentences[i]!.start < 25) j++;
    const len = sentences[j]!.end - sentences[i]!.start;
    if (len < 12 || len > 70) continue;
    const text = sentences.slice(i, j + 1).map((s) => s.text).join(" ");
    const n = text.split(/\s+/).length;
    windows.push({
      id: "", title: sentences[i]!.text.split(/\s+/).slice(0, 7).join(" "), mediaId, in: Math.max(0, sentences[i]!.start - 0.2),
      out: sentences[j]!.end + 0.3, hook: sentences[i]!.text.slice(0, 140), why: "picked automatically: dense, self-contained stretch of speech",
      score: 5, density: n / len + (/[!?]/.test(text) ? 0.3 : 0),
    });
  }
  const picked: ClipIdea[] = [];
  for (const w of windows.sort((a, b) => b.density - a.density)) {
    if (picked.length >= count) break;
    if (picked.every((p2) => w.out <= p2.in || w.in >= p2.out)) picked.push({ ...w, id: `c${picked.length + 1}` });
  }
  return picked.sort((a, b) => a.in - b.in);
}

/** The no-Claude edit: tight cuts on speech, bold captions, clean bright look, voice clean-up, library music. */
export function fallbackEdit(p: Project, opts: { range?: { mediaId: string; in: number; out: number }; music?: boolean } = {}): EditResult {
  const clips: Record<string, unknown>[] = [];
  let hasWords = false;
  for (const m of p.media) {
    if (m.kind !== "video" || m.steps.probe?.state !== "done") continue;
    if (opts.range && m.id !== opts.range.mediaId) continue;
    if (getAnalysis(p.id, m.id).words?.length) hasWords = true;
    const from = opts.range?.in ?? 0;
    const to = opts.range?.out ?? m.duration;
    let regions: { start: number; end: number }[] = [];
    try {
      regions = autoCutRegions(p, { mediaId: m.id, removeFillers: true, from, to });
    } catch {
      // no transcript or silence data: keep the clip whole
    }
    if (!regions.length) regions = [{ start: from, end: to }];
    for (const r of regions) clips.push({ id: `n${clips.length + 1}`, mediaId: m.id, in: r.start, out: r.end });
  }
  const r = applySpec(p, {
    ...p.spec,
    clips,
    captions: { ...p.spec.captions, enabled: hasWords, style: "bold" },
    grade: { ...p.spec.grade, preset: "clean_bright" },
    audio: { ...p.spec.audio, enhanceVoice: p.media.some((m) => !!m.enhanced) },
  }, "Night Shift: automatic edit");
  if (r.ok && opts.music && clips.length) {
    // A library track (never a guide-only one), drop on the first big moment after the opening.
    const t = searchTracks({ mood: p.spec.format.height > p.spec.format.width ? "hype" : "inspiring", includeGuide: false })[0]
      ?? searchTracks({ includeGuide: false })[0];
    if (t) useMusic(p, { trackId: t.id, alignDropAt: 1.5, volume: 0.18 });
  }
  return r;
}

/** A short's own project that shares the long video's media (hard links: no copy, no re-analysis). */
function setupClipProject(b: NightBatch, item: NightItem): string {
  const c = item.clip!;
  const existing = item.projectId ? getProject(item.projectId) : null;
  if (existing) return existing.id;
  const src = getProject(c.sourceProjectId);
  const m = src?.media.find((x) => x.id === c.mediaId);
  if (!src || !m) throw new Error("the long video this clip comes from is gone");
  const p = createProject(item.name, "short");
  p.night = { batchId: b.id };
  item.projectId = p.id;
  const from = mediaDir(src.id, m.id);
  const to = mediaDir(p.id, m.id);
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from, { withFileTypes: true })) {
    if (!f.isFile()) continue;
    try {
      linkSync(path.join(from, f.name), path.join(to, f.name));
    } catch {
      copyFileSync(path.join(from, f.name), path.join(to, f.name));
    }
  }
  p.media.push(structuredClone(m));
  saveProject(p);
  save(b);
  return p.id;
}

/** Long video → find its best moments, then queue one short per moment right after it. */
async function runScout(b: NightBatch, item: NightItem, signal: AbortSignal) {
  const pid = await setupProject(b, item, signal);
  if (!pid || signal.aborted) return;
  const count = b.settings.clipCount ?? 10;
  const p0 = getProject(pid)!;
  p0.name = `${item.name.replace(/ — finding the best moments$/, "")} (source)`;
  saveProject(p0);
  if (claudeAvailable(b)) {
    step(b, item, "editing", "Claude is watching for the best moments");
    await claude(b, item, pid, scoutText(b, item), signal, "scout");
    if (signal.aborted) return;
  }
  const p = getProject(pid)!;
  let ideas = (p.clipPlan ?? []).slice(0, count);
  if (!ideas.length) {
    const video = p.media.find((m) => m.kind === "video" && m.steps.probe?.state === "done");
    ideas = video ? heuristicClips(p, video.id, count) : [];
    if (ideas.length) log(b, `${item.name}: picked ${plural(ideas.length, "moment")} automatically (Claude wasn't available).`);
  }
  if (!ideas.length) throw new Error("no usable moments found (is there speech in it?)");
  const at = b.items.indexOf(item);
  const children: NightItem[] = ideas.map((c) => ({
    id: newId(), name: c.title, files: [], kind: "clip", state: "waiting",
    clip: { sourceProjectId: pid, mediaId: c.mediaId, in: c.in, out: c.out, hook: c.hook, why: c.why, score: c.score },
  }));
  b.items.splice(at + 1, 0, ...children);
  item.state = "done";
  item.step = `Found ${plural(children.length, "clip")}`;
  item.finishedAt = now();
  log(b, `${item.name.replace(/ — finding the best moments$/, "")}: found ${plural(children.length, "clip")} — editing each one next.`);
}

function sleepUntil(t: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, t - Date.now()));
    signal.addEventListener("abort", done);
  });
}

const claudeAvailable = (b: NightBatch) => !b.claudeOffUntil || Date.parse(b.claudeOffUntil) <= Date.now();

/** Drive Claude until it finishes, waiting out usage limits (Claude plans reset every few hours). */
async function claude(
  b: NightBatch, item: NightItem, projectId: string, text: string, signal: AbortSignal, job: "edit" | "scout" = "edit",
): Promise<"done" | "failed" | "cancelled"> {
  let errors = 0;
  for (let round = 0; round < 8; round++) {
    const r = await runAutonomous(projectId, text, {
      model: b.settings.model, hooks: b.settings.hooks, timeoutMs: CLAUDE_TIMEOUT, signal, job, clips: b.settings.clipCount ?? 10,
    });
    if (signal.aborted) return "cancelled";
    if (r.outcome === "done") return "done";
    if (r.outcome === "limit") {
      const until = Math.max(Date.now() + 60_000, r.resetsAt * 1000 + 90_000);
      if (until - Date.now() > MAX_LIMIT_WAIT) {
        b.claudeOffUntil = new Date(until).toISOString();
        log(b, `Claude's usage limit only resets at ${new Date(until).toLocaleString("en-GB")} — the rest of tonight gets the automatic edit.`);
        return "failed";
      }
      b.state = "waiting_limit";
      b.resumeAt = new Date(until).toISOString();
      item.step = `Waiting for Claude's usage limit to reset (${clock(until)})`;
      log(b, `Claude's usage limit was reached — pausing until ${clock(until)}, then continuing.`);
      await sleepUntil(until, signal);
      if (signal.aborted) return "cancelled";
      b.state = "running";
      b.resumeAt = undefined;
      step(b, item, "editing", "Claude is editing");
      text = "The usage limit has reset. Continue the Night Shift job exactly where you left off and finish it.";
      continue;
    }
    errors++;
    log(b, `${item.name}: Claude ${r.outcome === "timeout" ? "ran out of time" : "hit a problem"} (${r.message.slice(0, 160)}).`);
    if (errors >= 2) return "failed";
    text = "You were interrupted. Call get_project to see where the edit stands, then continue the Night Shift job and finish it.";
  }
  return "failed";
}

/** Create the item's project, move its clips in and analyse them. Returns the project id (null if cancelled). */
async function setupProject(b: NightBatch, item: NightItem, signal: AbortSignal): Promise<string | null> {
  const scriptOnly = b.settings.mode === "longform" && !!b.settings.script?.trim();
  let p = item.projectId ? getProject(item.projectId) : null;
  if (!p) {
    step(b, item, "ingesting", "Setting up the project");
    p = createProject(item.name, "short");
    p.night = { batchId: b.id };
    item.projectId = p.id;
    for (const f of item.files) {
      const src = path.join(incomingDir(b.id), f);
      if (!existsSync(src)) continue;
      const ext = path.extname(f);
      const m = newMediaRecord(p.id, path.basename(f, ext), ext, { type: "upload" });
      const dest = path.join(mediaDir(p.id, m.id), m.original);
      moveFile(src, dest);
      m.size = statSync(dest).size;
      p.media.push(m);
    }
    saveProject(p);
    if (!p.media.length && !scriptOnly) throw new Error("its clip files are missing");
  }
  const pid = p.id;
  if (active) active.projectId = pid;
  if (p.media.length) {
    // Analyse: transcript, silences, faces, voice clean-up.
    step(b, item, "ingesting", "Transcribing and analysing the footage");
    await Promise.all(p.media.filter(unfinished).map((m) => enqueueIngest(pid, m.id)));
    if (signal.aborted) return null;
    // Repair shaky / dark / noisy footage before anyone edits it (skipped for very long files).
    if (b.settings.autoFix !== false) {
      for (const m of getProject(pid)!.media) {
        const look = m.kind === "video" && !m.fixed ? getAnalysis(pid, m.id).look : undefined;
        const o = look ? autoFixOptions(look) : null;
        if (!look || !o || m.duration > 1800) continue;
        step(b, item, "ingesting", `Fixing footage: ${look.advice.notes.join(", ")}`);
        await fixMedia(pid, m.id, o);
        if (signal.aborted) return null;
      }
    }
  }
  const videos = getProject(pid)!.media.filter((m) => m.kind === "video" && m.steps.probe?.state === "done");
  if (!videos.length && !scriptOnly) throw new Error("couldn't read the video file");
  return pid;
}

/** A style-reference link → "title by channel (link)" via YouTube's official oEmbed (metadata only, never the video). */
async function describeReference(url: string): Promise<string> {
  try {
    const u = new URL(url);
    if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname)) {
      const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = (await r.json()) as { title?: string; author_name?: string };
        if (j.title) return `"${j.title}" by ${j.author_name ?? "unknown channel"} (${url})`;
      }
    }
  } catch {
    // offline or not a link — just pass it on as text
  }
  return url;
}

async function runItem(b: NightBatch, item: NightItem, signal: AbortSignal) {
  item.startedAt ??= now();
  item.error = undefined;
  try {
    if (item.kind === "scout") return await runScout(b, item, signal);
    const pid = item.kind === "clip" ? setupClipProject(b, item) : await setupProject(b, item, signal);
    if (!pid || signal.aborted) return;
    if (active) active.projectId = pid;
    await editAndDeliver(b, item, pid, signal);
  } catch (e) {
    if (signal.aborted) return;
    item.state = "error";
    item.step = undefined;
    item.error = (e as Error).message.slice(0, 300);
    item.finishedAt = now();
    log(b, `${item.name}: ${item.error}`);
  }
}

/** Format → Claude's autonomous edit (or the automatic one) → export → hook previews → morning summary. */
async function editAndDeliver(b: NightBatch, item: NightItem, pid: string, signal: AbortSignal) {
  {
    let p = getProject(pid)!;
    const videos = p.media.filter((m) => m.kind === "video" && m.steps.probe?.state === "done");

    // 3. Format.
    const platform: Brief["platform"] = b.settings.format !== "auto" ? b.settings.format
      : item.kind === "clip" ? "short"
      : b.settings.mode === "longform" ? "youtube"
      : videos.length ? autoPlatform(videos) : "youtube";
    p.brief = { ...p.brief, platform, goal: b.settings.instructions.slice(0, 500) };
    saveProject(p);
    if (p.spec.format.preset !== platform) {
      applySpec(p, { ...p.spec, format: { ...p.spec.format, preset: platform, ...FORMAT_PRESETS[platform] } }, "Night Shift: format");
    }
    const reference = b.settings.mode === "longform" && b.settings.reference ? await describeReference(b.settings.reference) : undefined;

    // 4. Claude edits on its own.
    let edit: NightItem["edit"] = "fallback";
    let claudeSummary: string | undefined;
    if (claudeAvailable(b)) {
      step(b, item, "editing", "Claude is editing");
      const r = await claude(b, item, pid, taskText(b, item, platform, reference), signal);
      if (signal.aborted) return;
      if (r === "done") claudeSummary = getProject(pid)!.claude.message; // read now: later steps don't touch it, but be safe
      if (r === "done" && !getProject(pid)!.hooks?.length && claudeAvailable(b)) {
        step(b, item, "editing", "Claude is writing hook ideas");
        await claude(b, item, pid, `You haven't proposed any hooks yet. Call propose_hooks now with ${b.settings.hooks} different hooks, preview your best one, then set_status "done".`, signal);
        if (signal.aborted) return;
      }
      edit = r === "done" ? "claude" : "partial";
    }
    p = getProject(pid)!;
    if (!p.spec.clips.length && !p.spec.audio.voice.length && !p.spec.overlays.length) {
      step(b, item, "editing", "Making the automatic edit");
      const range = item.clip ? { mediaId: item.clip.mediaId, in: item.clip.in, out: item.clip.out } : undefined;
      const r = fallbackEdit(p, { range, music: b.settings.music !== "none" });
      if (!r.ok) throw new Error(`the automatic edit failed: ${r.errors.join("; ")}`);
      edit = "fallback";
      log(b, `${item.name}: no edit from Claude — used the automatic edit (cuts, captions, light, music).`);
    }
    item.edit = edit;

    // 5. Export the full video.
    step(b, item, "rendering", "Exporting the video");
    let file = await queueExport(getProject(pid)!, "high", "night").catch(() => null);
    if (!file && !signal.aborted) {
      log(b, `${item.name}: the export failed — retrying once.`);
      file = await queueExport(getProject(pid)!, "high", "night").catch(() => null);
    }
    if (signal.aborted) return;
    item.exportFile = file ?? undefined;

    // 6. A short preview render of the opening with each hook, for the morning.
    p = getProject(pid)!;
    const hooks = p.hooks ?? [];
    item.hooks = hooks.length;
    if (hooks.length) {
      step(b, item, "rendering", `Rendering ${plural(hooks.length, "hook preview")}`);
      const base = p.hookBase ?? p.spec;
      const proj = p;
      await Promise.all(hooks.map((h) => {
        try {
          return queueHookPreview(proj, h, applyHook(base, h), hookPreviewSeconds(base, h));
        } catch {
          return null;
        }
      }));
      if (signal.aborted) return;
    }
    p = getProject(pid)!;
    const summary = edit === "fallback"
      ? "Automatic edit (Claude wasn't available): pauses and filler words cut, bold captions, clean bright look, voice clean-up. Open it in the editor to ask Claude for more."
      : claudeSummary;
    p.night = { batchId: b.id, summary };
    saveProject(p);
    if (!file) throw new Error("the export failed twice (the edit itself is saved — open it in the editor)");
    item.state = "done";
    item.step = undefined;
    item.finishedAt = now();
    log(b, `${item.name}: ready${hooks.length ? ` with ${plural(hooks.length, "hook idea")}` : ""}.`);
  }
}
