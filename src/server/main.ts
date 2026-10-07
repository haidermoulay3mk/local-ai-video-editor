// Video Editor local server: UI, project API, uploads, renders, Claude bridge, live updates.
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import index from "../ui/index.html";
import { AGENT_TOKEN, isClaudeBusy, reportStatus, resolveClaude, sendToClaude, stopAll, stopClaude } from "../claude/bridge";
import { totalSeconds } from "../shared/timeline";
import { type BusEvent, emit, subscribe } from "./bus";
import { HOST, PORT, TOOLS, whisperExePath, whisperModelPath } from "./config";
import {
  applyHookToProject, applySpec, autoCut, beatsFor, clearHook, fixFootageForClaude, generateVoiceover, makeMusic, previewStills, projectContext, proposeClips,
  proposeHooks, removeLayers, searchMusic, setClips, setPublishInfo, sourceFrames, speedRamp, transcriptText, updateSettings, upsertLayers, useMusic,
} from "./editor";
import {
  addTrack, deleteTrack, ensureStarterMusic, GENRES, getTrack, LICENSES, listTracks, MOODS, MUSIC_TMP, type MusicLicense, trackPath,
  updateTrack,
} from "./music";
import { GEN_STYLES } from "./music-gen";
import { getSettings, KEY_INFO, type KeyName, keyStatus, setKeys, setSettings } from "./keys";
import { findStock, generateImage, stockCredits } from "./stock";
import { makeThumbnails } from "./thumbs";
import { publishText, subtitleCues, toSrt, toVtt } from "../shared/publish";
import { VOICES } from "./tts";
import { safeJoin, serveFile, streamToFile } from "./files";
import { enqueueIngest, fixMedia, resumeIncomplete, undoFix } from "./ingest";
import { autoFixOptions } from "./look";
import {
  cancelBatch, createBatch, deleteBatch, finishIncoming, getBatch, importInbox, INBOX_DIR, inboxNew, initNight, keepingAwake, listBatches,
  openInbox, patchBatch, removeIncoming, reserveIncoming, startBatch, stopNight,
} from "./night";
import { cancelRenders, queueExport, queueHookPreview, renderState } from "./renders";
import { applyHook, hookPreviewSeconds } from "../shared/hooks";
import { ensureSfx, SFX_DIR } from "./sfx";
import {
  type Brief, compositionProps, createProject, deleteProject, getAnalysis, getProject, listProjects, mediaDir, newMediaRecord,
  type Project, projectDir, saveProject, undoSpec,
} from "./store";

ensureSfx();
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const MAX_UPLOAD = 8 * 1024 ** 3;
const SERVABLE =
  /^(media\/[a-z0-9]+\/(original|proxy|master|enhanced|fixed)\.[a-z0-9]+|media\/[a-z0-9]+\/frames\/[\w.-]+\.jpg|exports\/[\w.-]+\.(mp4|srt)|stills\/[\w.-]+\.jpg|thumbnails\/[\w.-]+\.jpg|hooks\/[\w.-]+\.mp4)$/i;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const MEDIA_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|webp|gif)$/i;

// Links to these sites are pages, not files, and their terms forbid downloading — style reference only.
const PLATFORM_HOSTS = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|vimeo\.com|snapchat\.com|twitch\.tv|dailymotion\.com|reddit\.com|redd\.it|threads\.net|linkedin\.com|pinterest\.com)$/i;


// Rendering lives in ./renders (a shared queue: exports, hook re-renders and Night Shift).

// ---------------------------------------------------------------- Music library API

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|webm)$/i;

async function musicApi(req: Request, url: URL, parts: string[]): Promise<Response> {
  const method = req.method;
  try {
    if (!parts.length && method === "GET") {
      return json({
        tracks: listTracks(), licenses: LICENSES, genres: GENRES, moods: MOODS, voices: VOICES,
        styles: Object.fromEntries(Object.entries(GEN_STYLES).map(([k, v]) => [k, { label: v.label, bpm: v.bpm }])),
      });
    }
    if (parts[0] === "upload" && method === "POST") {
      const q = url.searchParams;
      const name = decodeURIComponent(q.get("name") ?? "track.mp3");
      const ext = AUDIO_EXT.exec(name)?.[0];
      if (!ext) return fail("Music must be an audio file (mp3, wav, m4a, aac, ogg, flac).");
      if (!req.body) return fail("empty upload");
      mkdirSync(MUSIC_TMP, { recursive: true });
      const tmp = path.join(MUSIC_TMP, `${crypto.randomUUID()}${ext}`);
      try {
        await streamToFile(req.body, tmp, 400 * 1024 ** 2);
        const t = await addTrack(tmp, ext, {
          title: q.get("title") || name.replace(/\.[^.]+$/, ""), artist: q.get("artist") ?? undefined, genre: q.get("genre") ?? undefined,
          moods: (q.get("moods") ?? "").split(",").filter(Boolean), license: (q.get("license") ?? "") as MusicLicense,
          attribution: q.get("attribution") ?? undefined,
        });
        return json(t);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    if (parts[0] === "generate" && method === "POST") {
      const b = (await req.json()) as { style?: string; bpm?: number; seconds?: number };
      return json(await makeMusic(b.style ?? "phonk", b.bpm, b.seconds));
    }
    const t = getTrack(parts[0] ?? "");
    if (!t) return fail("track not found", 404);
    if (method === "PATCH") return json(updateTrack(t.id, (await req.json()) as Parameters<typeof updateTrack>[1]));
    if (method === "DELETE") {
      deleteTrack(t.id);
      return json({ ok: true });
    }
  } catch (e) {
    return fail((e as Error).message, 400);
  }
  return fail("not found", 404);
}

// ---------------------------------------------------------------- Night Shift API

async function nightApi(req: Request, url: URL, parts: string[]): Promise<Response> {
  const method = req.method;
  if (!parts.length) {
    if (method === "GET") return json({ batches: listBatches(), inbox: INBOX_DIR, inboxNew: inboxNew().length, keepingAwake: keepingAwake() });
    if (method === "POST") return json(createBatch());
  }
  if (parts[0] === "open-inbox" && method === "POST") {
    openInbox();
    return json({ ok: true });
  }
  const b = getBatch(parts[0] ?? "");
  if (!b) return fail("night shift not found", 404);
  try {
    switch (`${method} ${parts[1] ?? ""}`) {
      case "GET ":
        return json(b);
      case "PATCH ":
        return json(patchBatch(b, (await req.json()) as Parameters<typeof patchBatch>[1]));
      case "DELETE ":
        deleteBatch(b);
        return json({ ok: true });
      case "POST files": {
        if (!req.body) return fail("empty upload");
        const t = reserveIncoming(b, decodeURIComponent(url.searchParams.get("name") ?? ""));
        if (!t) return fail("Night Shift takes video files (mp4, mov, m4v, webm, mkv, avi).");
        try {
          finishIncoming(b, t.name, await streamToFile(req.body, t.file, MAX_UPLOAD));
        } catch (e) {
          removeIncoming(b, t.name);
          return fail((e as Error).message);
        }
        return json(b);
      }
      case "DELETE files":
        removeIncoming(b, decodeURIComponent(parts[2] ?? ""));
        return json(b);
      case "POST inbox":
        await importInbox(b);
        return json(b);
      case "POST start": {
        const body = (await req.json().catch(() => ({}))) as { startAt?: string };
        startBatch(b, body.startAt);
        return json(b);
      }
      case "POST cancel":
        cancelBatch(b);
        return json(b);
    }
  } catch (e) {
    return fail((e as Error).message, 409);
  }
  return fail("not found", 404);
}

// ---------------------------------------------------------------- API

async function api(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  const method = req.method;
  const body = async <T>() => (await req.json()) as T;

  if (parts[0] === "health") {
    return json({
      claude: resolveClaude(),
      ffmpeg: existsSync(TOOLS.ffmpeg),
      whisper: existsSync(whisperExePath()) && existsSync(whisperModelPath()),
      faces: existsSync(TOOLS.faceModel),
      node: !!Bun.which("node"),
    });
  }
  if (parts[0] === "night") return nightApi(req, url, parts.slice(1));
  if (parts[0] === "music") return musicApi(req, url, parts.slice(1));
  if (parts[0] === "settings") {
    if (method === "POST") return json(setSettings(await body<{ subscriptionOnly?: boolean }>()));
    return json(getSettings());
  }
  if (parts[0] === "keys") {
    // Optional free API keys: the UI only ever learns WHICH keys are set, never their values.
    if (method === "POST") return json({ set: setKeys(await body<Partial<Record<KeyName, string | null>>>()), info: KEY_INFO });
    return json({ set: keyStatus(), info: KEY_INFO });
  }
  if (parts[0] !== "projects") return fail("not found", 404);

  if (parts.length === 1) {
    if (method === "GET") return json(listProjects());
    if (method === "POST") {
      const b = await body<{ name?: string; platform?: Brief["platform"] }>();
      const platform = (["youtube", "short", "square", "portrait"] as const).includes(b.platform as Brief["platform"]) ? b.platform! : "short";
      return json(createProject(b.name ?? "", platform));
    }
  }

  const p = getProject(parts[1] ?? "");
  if (!p) return fail("project not found", 404);
  const sub = parts.slice(2);
  const route = `${method} ${sub[0] ?? ""}`;

  // ---------- Claude's tool routes (token protected)
  if (sub[0] === "agent") {
    if (req.headers.get("x-video-editor-token") !== AGENT_TOKEN) return fail("forbidden", 403);
    const r = `${method} ${sub[1] ?? ""}`;
    switch (r) {
      case "GET context": return new Response(projectContext(p));
      case "GET transcript": {
        const q = url.searchParams;
        const num = (k: string) => (q.get(k) === null ? undefined : Number(q.get(k)));
        return new Response(transcriptText(p, {
          mediaId: q.get("mediaId") ?? undefined, timeline: q.get("timeline") === "source" ? "source" : "output",
          words: q.get("words") === "true", from: num("from"), to: num("to"),
        }));
      }
      case "GET silences": {
        const min = Number(url.searchParams.get("min") ?? 0.4);
        const s = getAnalysis(p.id, url.searchParams.get("mediaId") ?? "").silences ?? [];
        return json(s.filter((x) => x.end - x.start >= min));
      }
      case "POST frames": {
        const b = await body<{ mediaId: string; times?: number[]; count?: number }>();
        return json({ frames: await sourceFrames(p, b.mediaId, b.times, b.count) });
      }
      case "POST preview": {
        const b = await body<{ times?: number[]; count?: number; hookId?: string }>();
        return json({ frames: await previewStills(p, b.times, b.count, b.hookId) });
      }
      case "POST hooks": {
        const b = await body<{ hooks: unknown[] }>();
        return json(proposeHooks(p, Array.isArray(b.hooks) ? b.hooks : []));
      }
      case "POST auto-cut": return json(autoCut(p, await body()));
      case "POST speed-ramp": return json(speedRamp(p, await body()));
      case "POST clips": {
        const b = await body<{ clips: unknown[]; reason?: string }>();
        return json(setClips(p, b.clips, b.reason ?? "Claude: clips"));
      }
      case "POST music": {
        const b = await body<Record<string, unknown>>();
        const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
        if (sub[2] === "search") return json(searchMusic(b));
        if (sub[2] === "use") return json(useMusic(p, b as Parameters<typeof useMusic>[1]));
        if (sub[2] === "beats") return json(beatsFor(p, String(b.musicId), num(b.from) ?? 0, num(b.to) ?? Number.POSITIVE_INFINITY, num(b.subdivide) ?? 1));
        if (sub[2] === "generate") return json(await makeMusic(String(b.style), num(b.bpm), num(b.seconds)));
        return fail("unknown music route", 404);
      }
      case "POST voiceover":
        return json(await generateVoiceover(p, await body()));
      case "POST fix":
        return json(await fixFootageForClaude(p, await body()));
      case "POST stock":
        return json(await findStock(p, await body()));
      case "POST publish":
        return json(setPublishInfo(p, await body()));
      case "POST thumbnails": {
        const r = await makeThumbnails(p, await body());
        return json({ thumbnails: r.thumbnails, frames: r.images.map((im, i) => ({ t: i, base64: im.base64 })) });
      }
      case "POST image":
        return json(await generateImage(p, await body()));
      case "POST clip-ideas": {
        const b = await body<{ clips: unknown[] }>();
        return json(proposeClips(p, Array.isArray(b.clips) ? b.clips : []));
      }
      case "POST layers": {
        const b = await body<{ overlays?: unknown[]; effects?: unknown[]; music?: unknown[]; sfx?: unknown[]; reason?: string }>();
        return json(upsertLayers(p, b, b.reason ?? "Claude: layers"));
      }
      case "POST remove": {
        const b = await body<{ ids: string[]; reason?: string }>();
        return json(removeLayers(p, b.ids, b.reason ?? "Claude: remove"));
      }
      case "POST settings": {
        const b = await body<{ patch: Record<string, unknown>; reason?: string }>();
        return json(updateSettings(p, b.patch, b.reason ?? "Claude: settings"));
      }
      case "PUT spec": {
        const b = await body<{ spec: unknown; reason?: string }>();
        return json(applySpec(p, b.spec, b.reason ?? "Claude: full spec"));
      }
      case "POST undo": return new Response(undoSpec(p.id) ? "Undone." : "Nothing to undo.");
      case "POST status": {
        const b = await body<{ state: "working" | "needs_user" | "done"; message: string; options?: string[] }>();
        reportStatus(p.id, b.state, b.message, b.options);
        return new Response(b.state === "working" ? "OK — the app will tell you to continue." : "OK.");
      }
    }
    return fail("unknown agent route", 404);
  }

  switch (route) {
    case "GET ":
      return json(p);
    case "PATCH ": {
      const b = await body<{ name?: string; brief?: Partial<Brief> }>();
      if (typeof b.name === "string" && b.name.trim()) p.name = b.name.trim().slice(0, 80);
      if (b.brief) {
        p.brief = { ...p.brief, ...b.brief, references: (b.brief.references ?? p.brief.references).slice(0, 10) };
      }
      saveProject(p);
      return json(p);
    }
    case "DELETE ": {
      stopClaude(p.id);
      cancelRenders(p.id);
      deleteProject(p.id);
      return json({ ok: true });
    }
    case "GET props":
      return json(compositionProps(p, true));
    case "PUT spec": {
      const b = await body<{ spec: unknown; reason?: string }>();
      return json(applySpec(p, b.spec, b.reason ?? "manual edit"));
    }
    case "POST undo":
      return json({ ok: undoSpec(p.id) });
    case "POST hooks": {
      // "Use this hook" (apply + render the final video) or "Remove hook".
      if (sub[1] === "clear") return json(clearHook(p));
      if (sub[1] === "previews") {
        // Short draft renders of each hook's opening (Night Shift does this itself; this is for hooks made in chat).
        const base = p.hookBase ?? p.spec;
        const todo = (p.hooks ?? []).filter((h) => h.previewState !== "done" && h.previewState !== "rendering");
        for (const h of todo) {
          try {
            void queueHookPreview(p, h, applyHook(base, h), hookPreviewSeconds(base, h));
          } catch {
            h.previewState = "error";
          }
        }
        saveProject(p);
        return json({ queued: todo.length });
      }
      const hookId = decodeURIComponent(sub[1] ?? "");
      if (sub[2] !== "apply") return fail("not found", 404);
      const r = applyHookToProject(p, hookId);
      if (r.ok) void queueExport(p, "high", `hook-${hookId}`).catch(() => {});
      return json(r);
    }
    case "POST media": {
      if (sub[2] === "fix" || sub[2] === "unfix") {
        // "Fix footage" / "Undo fix" from the footage panel. Runs in the background; progress comes over the socket.
        const m = p.media.find((x) => x.id === sub[1]);
        if (!m || m.kind !== "video") return fail("not a video in this project", 404);
        if (sub[2] === "unfix") {
          void undoFix(p.id, m.id);
          return json({ ok: true });
        }
        const look = getAnalysis(p.id, m.id).look;
        if (!look) return fail("This video is still being analysed.", 409);
        const b = await body<{ whiteBalance?: boolean }>();
        const auto = autoFixOptions(look) ?? {};
        const opts = { ...auto, whiteBalance: auto.whiteBalance || (!!b.whiteBalance && !!look.advice.whiteBalance) };
        if (!opts.stabilize && !opts.denoise && !opts.color && !opts.whiteBalance) return fail("Nothing to fix — this footage looks fine.", 409);
        void fixMedia(p.id, m.id, opts);
        return json({ ok: true, opts });
      }
      if (sub[1] === "url") {
        const b = await body<{ url: string; rightsConfirmed?: boolean }>();
        let u: URL;
        try {
          u = new URL(b.url);
        } catch {
          return fail("That isn't a valid link.");
        }
        if (!/^https?:$/.test(u.protocol)) return fail("Only http(s) links are supported.");
        if (PLATFORM_HOSTS.test(u.hostname)) {
          return fail("Links to YouTube/Instagram/TikTok etc. are web pages, and their terms don't allow downloading. For YOUR OWN videos: download the original from YouTube Studio or Instagram's “Download your information”, then upload the file. To copy another creator's look, add the link as a Style reference instead.", 422);
        }
        if (!b.rightsConfirmed) return fail("Please confirm you own this file or have the rights to edit it.", 422);
        const res = await fetch(u, { redirect: "follow" });
        if (PLATFORM_HOSTS.test(new URL(res.url).hostname)) {
          // A shortener/redirect must not smuggle in a platform download.
          await res.body?.cancel();
          return fail("That link redirects to a video platform page, which can't be downloaded. Upload your own file instead, or add it as a Style reference.", 422);
        }
        const type = res.headers.get("content-type") ?? "";
        if (!res.ok || !res.body) return fail(`Download failed (HTTP ${res.status}).`);
        if (!/^(video|audio|image)\//.test(type)) return fail("That link is a web page, not a direct video/audio/image file.");
        const name = decodeURIComponent(u.pathname.split("/").pop() || "linked-media");
        const ext = MEDIA_EXT.exec(name)?.[0] ?? (type.startsWith("video") ? ".mp4" : type.startsWith("audio") ? ".m4a" : ".jpg");
        const m = newMediaRecord(p.id, name, ext, { type: "url", url: u.toString(), rightsConfirmed: true });
        try {
          m.size = await streamToFile(res.body, path.join(mediaDir(p.id, m.id), m.original), MAX_UPLOAD);
        } catch (e) {
          rmSync(mediaDir(p.id, m.id), { recursive: true, force: true });
          return fail((e as Error).message);
        }
        p.media.push(m);
        saveProject(p);
        enqueueIngest(p.id, m.id);
        return json(m);
      }
      const name = decodeURIComponent(url.searchParams.get("name") ?? "upload.mp4");
      const ext = MEDIA_EXT.exec(name)?.[0];
      if (!ext) return fail("Unsupported file type. Use a video (mp4/mov/webm/mkv), audio (mp3/wav/m4a) or image (png/jpg/webp).");
      if (!req.body) return fail("empty upload");
      const m = newMediaRecord(p.id, name, ext, { type: "upload" });
      try {
        m.size = await streamToFile(req.body, path.join(mediaDir(p.id, m.id), m.original), MAX_UPLOAD);
      } catch (e) {
        rmSync(mediaDir(p.id, m.id), { recursive: true, force: true });
        return fail((e as Error).message);
      }
      p.media.push(m);
      saveProject(p);
      enqueueIngest(p.id, m.id);
      return json(m);
    }
    case "DELETE media": {
      const mid = sub[1] ?? "";
      const used = p.spec.clips.some((c) => c.mediaId === mid) ||
        p.spec.overlays.some((o) => "mediaId" in o && o.mediaId === mid) ||
        p.spec.audio.music.some((m) => m.mediaId === mid) || p.spec.audio.sfx.some((s) => s.sound === mid);
      if (used) return fail("This file is used in the edit — remove it from the edit first.", 409);
      p.media = p.media.filter((m) => m.id !== mid);
      saveProject(p);
      rmSync(mediaDir(p.id, mid), { recursive: true, force: true });
      return json({ ok: true });
    }
    case "POST chat": {
      if (sub[1] === "stop") {
        stopClaude(p.id);
        return json({ ok: true });
      }
      const b = await body<{ text: string; model?: string }>();
      const text = (b.text ?? "").trim().slice(0, 4000);
      if (!text) return fail("empty message");
      try {
        sendToClaude(p.id, text, b.model);
      } catch (e) {
        return fail((e as Error).message, 500);
      }
      return json({ ok: true, busy: isClaudeBusy(p.id) });
    }
    case "POST render": {
      if (sub[1] === "cancel") {
        cancelRenders(p.id);
        return json({ ok: true });
      }
      const b = await body<{ quality?: "high" | "draft" }>();
      try {
        if (!p.spec.clips.length && !p.spec.overlays.length) throw new Error("Nothing to render yet.");
        void queueExport(p, b.quality === "draft" ? "draft" : "high").catch(() => {});
        return json({ queued: true });
      } catch (e) {
        return fail((e as Error).message, 409);
      }
    }
    case "GET render":
      return json(renderState(p.id));
    case "POST exports": {
      // Show the exported file in Windows Explorer.
      const full = safeJoin(path.join(projectDir(p.id), "exports"), decodeURIComponent(sub[1] ?? ""));
      if (sub[2] !== "reveal" || !full || !existsSync(full)) return fail("not found", 404);
      Bun.spawn(["explorer.exe", `/select,${full}`], { stdout: "ignore", stderr: "ignore" });
      return json({ ok: true });
    }
    case "DELETE exports": {
      const file = decodeURIComponent(sub[1] ?? "");
      p.exports = p.exports.filter((e) => e.file !== file);
      saveProject(p);
      const full = safeJoin(path.join(projectDir(p.id), "exports"), file);
      if (full) rmSync(full, { force: true });
      if (full) rmSync(full.replace(/\.mp4$/i, ".srt"), { force: true });
      return json({ ok: true });
    }
    case "GET publish": {
      // Upload text (title / description with chapters, hashtags, credits) + which subtitle lines exist.
      const credits = stockCredits(p);
      const cues = subtitleCues(p.spec, compositionProps(p, false).analysis);
      return json({ info: p.publish ?? null, text: p.publish ? publishText(p.publish, credits) : null, credits, subtitleLines: cues.length, thumbnails: p.thumbnails ?? [] });
    }
    case "PUT publish":
      // The creator editing the upload text by hand (Claude uses set_publish_info).
      return json(setPublishInfo(p, await body()));
    case "GET subtitles": {
      const vtt = url.searchParams.get("format") === "vtt";
      const cues = subtitleCues(p.spec, compositionProps(p, false).analysis);
      if (!cues.length) return fail("Nothing is spoken in this edit, so there are no subtitles.", 404);
      const name = `${p.name.replace(/[^\w-]+/g, "-").slice(0, 40) || "video"}.${vtt ? "vtt" : "srt"}`;
      return new Response(vtt ? toVtt(cues) : toSrt(cues), {
        headers: { "content-type": vtt ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
      });
    }
    case "POST thumbnails": {
      const b = await body<{ text: string; emoji?: string; count?: number }>();
      const r = await makeThumbnails(p, b);
      return json({ thumbnails: r.thumbnails });
    }
    case "DELETE thumbnails": {
      const file = decodeURIComponent(sub[1] ?? "");
      p.thumbnails = (p.thumbnails ?? []).filter((t) => t.file !== file);
      saveProject(p);
      const full = safeJoin(path.join(projectDir(p.id), "thumbnails"), file);
      if (full) rmSync(full, { force: true });
      return json({ ok: true });
    }
  }
  return fail("not found", 404);
}

// ---------------------------------------------------------------- server

type WsData = { projectId: string; unsubscribe?: () => void };

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  maxRequestBodySize: MAX_UPLOAD,
  idleTimeout: 255, // previews/renders can take a while
  development: process.env.NODE_ENV !== "production",
  routes: { "/": index },
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (!HOSTS.has(req.headers.get("host") ?? "")) return new Response("Forbidden host", { status: 403 }); // DNS-rebinding guard

    if (url.pathname === "/ws") {
      // Browsers let any site open a WebSocket to localhost; only our own page may listen.
      const origin = req.headers.get("origin");
      if (!origin || !ORIGINS.has(origin)) return new Response("Forbidden origin", { status: 403 });
      const projectId = url.searchParams.get("project") ?? "";
      return srv.upgrade(req, { data: { projectId } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/api/")) {
      const origin = req.headers.get("origin");
      if (req.method !== "GET") {
        // CSRF guard: browsers can't add custom headers cross-site without a CORS preflight we never allow.
        if (req.headers.get("x-video-editor") !== "1" || (origin && !ORIGINS.has(origin))) return fail("forbidden", 403);
      }
      try {
        return await api(req, url);
      } catch (err) {
        console.error(err);
        return fail(err instanceof Error ? err.message : String(err), 500);
      }
    }

    if (url.pathname.startsWith("/files/")) {
      const [, , projectId = "", ...rest] = url.pathname.split("/");
      const rel = decodeURIComponent(rest.join("/"));
      // Only media, exports and preview images are served (cross-origin readable so the renderer can
      // stream them). Transcripts (analysis.json), project.json and Claude's config are never served.
      if (!SERVABLE.test(rel)) return new Response("Not found", { status: 404 });
      const p = getProject(projectId);
      const file = p ? safeJoin(projectDir(p.id), rel) : null;
      if (!file) return new Response("Not found", { status: 404 });
      const download = url.searchParams.get("download");
      return serveFile(req, file, download ? { "Content-Disposition": `attachment; filename="${path.basename(file)}"` } : {});
    }

    if (url.pathname.startsWith("/music-files/")) {
      // Library tracks, for the Music page's play buttons (only files that are in the library).
      const t = getTrack(decodeURIComponent(url.pathname.slice("/music-files/".length)));
      return t ? serveFile(req, trackPath(t)) : new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith("/sfx/")) {
      const file = safeJoin(SFX_DIR, decodeURIComponent(url.pathname.slice(5)));
      return file ? serveFile(req, file) : new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      ws.data.unsubscribe = subscribe((e: BusEvent) => {
        if (e.projectId === ws.data.projectId) ws.send(JSON.stringify(e));
      });
    },
    message() {},
    close(ws: ServerWebSocket<WsData>) {
      ws.data.unsubscribe?.();
    },
  },
});

resumeIncomplete(listProjects().map((p) => p.id));
initNight(); // resumes a shift the app was closed in the middle of, and runs the scheduler
void ensureStarterMusic(); // first run: a few original beats so Claude always has music to work with
console.log(`\n  Video Editor is running → http://${HOST}:${server.port}\n`);
if (!resolveClaude()) console.warn("  ! Claude Code CLI not found — chat will not work until it's installed and logged in.");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopNight();
    stopAll();
    cancelRenders();
    process.exit(0);
  });
}
