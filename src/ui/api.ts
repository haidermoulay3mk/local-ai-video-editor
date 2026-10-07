// Browser-side API client + live project state (REST for reads/writes, WebSocket for pushes).
import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "../server/music";
import type { NightBatch, NightSettings } from "../server/night";
import type { Brief, ChatMessage, ExportRecord, MediaRecord, Project, StoredHook } from "../server/store";
import type { CompositionProps, Spec } from "../shared/spec";

export type { Brief, ChatMessage, ExportRecord, MediaRecord, NightBatch, NightSettings, Project, StoredHook, Track };
export type MusicLibrary = {
  tracks: Track[];
  licenses: Record<string, string>;
  genres: string[];
  moods: string[];
  voices: Record<string, string>;
  styles: Record<string, { label: string; bpm: number }>;
};
export type ProjectSummary = Pick<Project, "id" | "name" | "updatedAt" | "brief">;
export type Health = { claude: string | null; ffmpeg: boolean; whisper: boolean; faces: boolean; node: boolean };
export type EditResult = { ok: boolean; errors: string[]; warnings: string[]; summary: string };
export type RenderState = { state: "queued" | "running" | "done" | "error" | "cancelled"; progress?: number; file?: string; error?: string };
export type NightOverview = { batches: NightBatch[]; inbox: string; inboxNew: number; keepingAwake: boolean };
export type Usage = { status?: string; unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> };

const HEADERS = { "x-video-editor": "1", "content-type": "application/json" };

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

const P = (id: string) => `/api/projects/${id}`;

export const api = {
  health: () => req<Health>("GET", "/api/health"),
  projects: () => req<ProjectSummary[]>("GET", "/api/projects"),
  create: (name: string, platform: Brief["platform"]) => req<Project>("POST", "/api/projects", { name, platform }),
  project: (id: string) => req<Project>("GET", P(id)),
  props: (id: string) => req<CompositionProps>("GET", `${P(id)}/props`),
  patch: (id: string, body: { name?: string; brief?: Partial<Brief> }) => req<Project>("PATCH", P(id), body),
  remove: (id: string) => req<{ ok: true }>("DELETE", P(id)),
  putSpec: (id: string, spec: Spec, reason: string) => req<EditResult>("PUT", `${P(id)}/spec`, { spec, reason }),
  undo: (id: string) => req<{ ok: boolean }>("POST", `${P(id)}/undo`),
  chat: (id: string, text: string, model?: string) => req<{ ok: true }>("POST", `${P(id)}/chat`, { text, model }),
  stop: (id: string) => req<{ ok: true }>("POST", `${P(id)}/chat/stop`),
  render: (id: string, quality: "high" | "draft") => req<{ file: string }>("POST", `${P(id)}/render`, { quality }),
  cancelRender: (id: string) => req<{ ok: true }>("POST", `${P(id)}/render/cancel`),
  renderState: (id: string) => req<{ running: boolean; queued: number; file: string | null }>("GET", `${P(id)}/render`),
  /** "Use this hook": puts it at the start of the edit and renders the final video. */
  useHook: (id: string, hookId: string) => req<EditResult>("POST", `${P(id)}/hooks/${encodeURIComponent(hookId)}/apply`),
  clearHook: (id: string) => req<EditResult>("POST", `${P(id)}/hooks/clear`),
  renderHookPreviews: (id: string) => req<{ queued: number }>("POST", `${P(id)}/hooks/previews`),
  addUrl: (id: string, url: string, rightsConfirmed: boolean) => req<MediaRecord>("POST", `${P(id)}/media/url`, { url, rightsConfirmed }),
  deleteMedia: (id: string, mid: string) => req<{ ok: true }>("DELETE", `${P(id)}/media/${mid}`),
  fixMedia: (id: string, mid: string, whiteBalance = false) => req<{ ok: true }>("POST", `${P(id)}/media/${mid}/fix`, { whiteBalance }),
  unfixMedia: (id: string, mid: string) => req<{ ok: true }>("POST", `${P(id)}/media/${mid}/unfix`, {}),
  deleteExport: (id: string, file: string) => req<{ ok: true }>("DELETE", `${P(id)}/exports/${encodeURIComponent(file)}`),
  reveal: (id: string, file: string) => req<{ ok: true }>("POST", `${P(id)}/exports/${encodeURIComponent(file)}/reveal`),
  fileUrl: (id: string, rel: string, download = false) => `/files/${id}/${rel}${download ? "?download=1" : ""}`,

  upload: (id: string, file: File, onProgress: (p: number) => void) =>
    sendFile<MediaRecord>(`${P(id)}/media?name=${encodeURIComponent(file.name)}`, file, onProgress),
  /** Publish kit: upload text, subtitle availability and thumbnails. */
  publish: (id: string) => req<PublishState>("GET", `${P(id)}/publish`),
  makeThumbnails: (id: string, text: string, emoji?: string) => req<{ thumbnails: ThumbRecord[] }>("POST", `${P(id)}/thumbnails`, { text, emoji }),
  deleteThumbnail: (id: string, file: string) => req<{ ok: true }>("DELETE", `${P(id)}/thumbnails/${encodeURIComponent(file)}`),
  subtitlesUrl: (id: string, format: "srt" | "vtt") => `${P(id)}/subtitles?format=${format}`,
  /** Optional free API keys — the server only ever reports WHICH are set, never the values. */
  keys: () => req<KeysInfo>("GET", "/api/keys"),
  settings: () => req<{ subscriptionOnly: boolean }>("GET", "/api/settings"),
  setSettings: (patch: { subscriptionOnly?: boolean }) => req<{ subscriptionOnly: boolean }>("POST", "/api/settings", patch),
  setKeys: (patch: Record<string, string | null>) => req<KeysInfo>("POST", "/api/keys", patch),
};

export type KeysInfo = { set: Record<string, boolean>; info: Record<string, { env: string; what: string; getAt: string }> };

/** Streams a file to the server (never held in memory) with progress callbacks. */
function sendFile<T>(url: string, file: File, onProgress: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.setRequestHeader("x-video-editor", "1");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      const j = JSON.parse(x.responseText || "{}") as T & { error?: string };
      if (x.status >= 200 && x.status < 300) resolve(j);
      else reject(new Error(j.error ?? `Upload failed (${x.status})`));
    };
    x.onerror = () => reject(new Error("Upload failed — is the Video Editor still running?"));
    x.send(file);
  });
}

const N = (id: string) => `/api/night/${id}`;

export const night = {
  overview: () => req<NightOverview>("GET", "/api/night"),
  create: () => req<NightBatch>("POST", "/api/night"),
  get: (id: string) => req<NightBatch>("GET", N(id)),
  patch: (id: string, body: { name?: string; settings?: Partial<NightSettings> }) => req<NightBatch>("PATCH", N(id), body),
  remove: (id: string) => req<{ ok: true }>("DELETE", N(id)),
  removeFile: (id: string, name: string) => req<NightBatch>("DELETE", `${N(id)}/files/${encodeURIComponent(name)}`),
  importInbox: (id: string) => req<NightBatch>("POST", `${N(id)}/inbox`),
  openInbox: () => req<{ ok: true }>("POST", "/api/night/open-inbox"),
  start: (id: string, startAt?: string) => req<NightBatch>("POST", `${N(id)}/start`, { startAt }),
  cancel: (id: string) => req<NightBatch>("POST", `${N(id)}/cancel`),
  upload: (id: string, file: File, onProgress: (p: number) => void) =>
    sendFile<NightBatch>(`${N(id)}/files?name=${encodeURIComponent(file.name)}`, file, onProgress),
};

export type TrackMeta = { title?: string; artist?: string; genre?: string; moods?: string[]; license: string; attribution?: string };

export const music = {
  library: () => req<MusicLibrary>("GET", "/api/music"),
  upload(file: File, meta: TrackMeta, onProgress: (p: number) => void) {
    const q = new URLSearchParams({ name: file.name, license: meta.license });
    if (meta.title) q.set("title", meta.title);
    if (meta.artist) q.set("artist", meta.artist);
    if (meta.genre) q.set("genre", meta.genre);
    if (meta.moods?.length) q.set("moods", meta.moods.join(","));
    if (meta.attribution) q.set("attribution", meta.attribution);
    return sendFile<Track>(`/api/music/upload?${q}`, file, onProgress);
  },
  generate: (style: string, bpm?: number, seconds?: number) => req<{ trackId: string }>("POST", "/api/music/generate", { style, bpm, seconds }),
  patch: (id: string, patch: Partial<TrackMeta>) => req<Track>("PATCH", `/api/music/${id}`, patch),
  remove: (id: string) => req<{ ok: true }>("DELETE", `/api/music/${id}`),
  fileUrl: (id: string) => `/music-files/${id}`,
};

/** Calls onChange (debounced) whenever any Night Shift changes, and once on (re)connect. */
export function useNightLive(onChange: () => void) {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 500;
    let t: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => latest.current(), 150);
    };
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws?project=__night`);
      ws.onopen = () => {
        retry = 500;
        fire();
      };
      ws.onmessage = fire;
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
      if (t) clearTimeout(t);
    };
  }, []);
}

type BusEvent =
  | { type: "project" | "spec"; projectId: string }
  | { type: "progress"; projectId: string; task: string; mediaId?: string; progress: number }
  | { type: "chat"; projectId: string; message: ChatMessage }
  | { type: "claude"; projectId: string; state: string; detail?: { message?: string; options?: string[] } & Usage }
  | ({ type: "render"; projectId: string } & RenderState);

/** Live view of one project. Re-fetches on change events, appends chat in place, tracks progress. */
export function useProject(id: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [props, setProps] = useState<CompositionProps | null>(null);
  const [progress, setProgress] = useState<Record<string, { task: string; progress: number }>>({});
  const [render, setRender] = useState<RenderState | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, pr] = await Promise.all([api.project(id), api.props(id)]);
      setProject(p);
      setProps(pr);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 120);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    void api.renderState(id).then((r) => {
      if (r.running) setRender({ state: "running", progress: 0 });
      else if (r.queued) setRender({ state: "queued" });
    }).catch(() => {});
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 500;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws?project=${id}`);
      ws.onopen = () => {
        retry = 500;
        soon(); // catch up on anything missed while disconnected
      };
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data as string) as BusEvent;
        if (e.type === "project" || e.type === "spec") soon();
        else if (e.type === "progress" && e.mediaId) setProgress((s) => ({ ...s, [e.mediaId!]: { task: e.task, progress: e.progress } }));
        else if (e.type === "chat") {
          setProject((p) => (p && !p.chat.some((c) => c.id === e.message.id) ? { ...p, chat: [...p.chat, e.message] } : p));
        } else if (e.type === "claude") {
          if (e.state === "usage") setUsage(e.detail ?? null);
          else setProject((p) => (p ? { ...p, claude: { ...p.claude, status: e.state as Project["claude"]["status"], message: e.detail?.message, options: e.detail?.options } } : p));
        } else if (e.type === "render") {
          setRender({ state: e.state, progress: e.progress, file: e.file, error: e.error });
          if (e.state === "done") soon();
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id, refresh, soon]);

  return { project, props, progress, render, setRender, usage, error, refresh };
}

export const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

export const fmtTimecode = (frame: number, fps: number) => {
  const totalS = Math.floor(frame / fps);
  const f = Math.floor(frame % fps);
  const h = Math.floor(totalS / 3600), m = Math.floor((totalS % 3600) / 60), s = totalS % 60;
  return [h, m, s, f].map((v) => String(v).padStart(2, "0")).join(":");
};

export const fmtBytes = (b: number) =>
  b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b > 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

export type ThumbRecord = { file: string; text: string; mediaId: string; t: number; createdAt: string };
export type PublishState = {
  info: { title: string; description: string; hashtags: string[]; chapters: { at: number; title: string }[]; pinnedComment?: string } | null;
  text: string | null;
  credits: string[];
  subtitleLines: number;
  thumbnails: ThumbRecord[];
};
