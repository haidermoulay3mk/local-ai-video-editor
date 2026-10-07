// The editor's MCP tool server — the ONLY tools the headless Claude session can use.
// Started by the `claude` CLI (stdio). Each tool forwards to the local Video Editor API.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HookSchema } from "../shared/hooks";
import {
  ClipSchema, EffectSchema, MusicSchema, OverlaySchema, SfxSchema, SpecSchema, VoiceSchema,
} from "../shared/spec";

const PROJECT = process.env.VIDEO_EDITOR_PROJECT ?? "";
const API = process.env.VIDEO_EDITOR_API ?? "http://127.0.0.1:4600";
const TOKEN = process.env.VIDEO_EDITOR_TOKEN ?? "";
const base = `${API}/api/projects/${PROJECT}/agent`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

async function call(method: "GET" | "POST" | "PUT", route: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}/${route}`, {
    method,
    headers: { "content-type": "application/json", "x-video-editor": "1", "x-video-editor-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const text = (t: string, isError = false): Result => ({ content: [{ type: "text", text: t }], isError });

type Edit = { ok: boolean; errors: string[]; warnings: string[]; summary: string; removedSeconds?: number };
function editResult(r: Edit): Result {
  if (!r.ok) return text(`REJECTED — nothing was changed. Fix these and retry:\n- ${r.errors.join("\n- ")}`, true);
  const extra = r.removedSeconds !== undefined ? `\nRemoved ${r.removedSeconds}s of silence/fillers.` : "";
  const warn = r.warnings.length ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  return text(`OK. ${r.summary}${extra}${warn}`);
}

function guard<A>(fn: (a: A) => Promise<Result>) {
  return async (a: A): Promise<Result> => {
    try {
      return await fn(a);
    } catch (err) {
      return text(`Tool error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };
}

function frames(label: string, list: { t: number; base64: string }[]): Result {
  const content: Content[] = [{ type: "text", text: `${label} (${list.length} frames, in order):` }];
  for (const f of list) {
    content.push({ type: "text", text: `t=${f.t.toFixed(2)}s` });
    content.push({ type: "image", data: f.base64, mimeType: "image/jpeg" });
  }
  return { content };
}

const server = new McpServer({ name: "editor", version: "0.1.0" });
const reason = z.string().max(200).optional().describe("Short note for the undo history, e.g. 'add hook title'");

server.registerTool("get_project", {
  description: "Brief, media list (ids, durations, transcript/face status) and the FULL current edit spec as JSON. Call first, and again whenever you need the current state.",
}, guard(async () => text(String(await call("GET", "context")))));

server.registerTool("get_transcript", {
  description: "Transcript lines with timestamps. timeline='source' = times inside one media file (use for clip in/out). timeline='output' = times in the edited video after cuts/speed (use for overlays, effects, captions, sfx). words=true gives per-word timing (use a from/to range to keep it short).",
  inputSchema: {
    timeline: z.enum(["source", "output"]).default("output"),
    mediaId: z.string().optional(),
    words: z.boolean().default(false),
    from: z.number().optional(),
    to: z.number().optional(),
  },
}, guard(async (a) => {
  const q = new URLSearchParams({ timeline: a.timeline, words: String(a.words) });
  if (a.mediaId) q.set("mediaId", a.mediaId);
  if (a.from !== undefined) q.set("from", String(a.from));
  if (a.to !== undefined) q.set("to", String(a.to));
  return text(String(await call("GET", `transcript?${q}`)));
}));

server.registerTool("get_silences", {
  description: "Detected silent ranges (source time) of a media file.",
  inputSchema: { mediaId: z.string(), minDuration: z.number().default(0.4) },
}, guard(async (a) => text(JSON.stringify(await call("GET", `silences?mediaId=${encodeURIComponent(a.mediaId)}&min=${a.minDuration}`)))));

server.registerTool("view_source_frames", {
  description: "LOOK at the raw footage: frames from a media file at source times (max 8). Use to understand framing, lighting, background, what is on screen.",
  inputSchema: { mediaId: z.string(), times: z.array(z.number().min(0)).max(8).optional(), count: z.number().int().min(1).max(8).default(6) },
}, guard(async (a) => {
  const r = (await call("POST", "frames", a)) as { frames: { t: number; base64: string }[] };
  return frames(`Source frames of ${a.mediaId}`, r.frames);
}));

server.registerTool("preview_edit", {
  description: "RENDER and LOOK at your current edit at output times (max 6, ~5-15s). Use after changes to check text legibility, overlaps with the face, caption position, colours. Self-review before telling the user you're done. Pass hookId to see the edit with one of your proposed hooks applied (defaults to its first ~3.5 s).",
  inputSchema: {
    times: z.array(z.number().min(0)).max(6).optional(),
    count: z.number().int().min(1).max(6).default(4),
    hookId: z.string().optional(),
  },
}, guard(async (a) => {
  const r = (await call("POST", "preview", a)) as { frames: { t: number; base64: string }[] };
  return frames(a.hookId ? `Preview with hook "${a.hookId}"` : "Rendered preview", r.frames);
}));

server.registerTool("propose_hooks", {
  description: "Store HOOK PROPOSALS for the creator to choose from (replaces earlier proposals). They are NOT applied to the edit. Each hook is a self-contained opening: optional `prepend` clips (a cold open from the strongest moment, SOURCE times, 1.5-4 s — everything after shifts later automatically) plus overlays/effects/sfx timed in FINAL output seconds from 0. Each is validated by applying it; invalid ones are reported back.",
  inputSchema: { hooks: z.array(HookSchema).min(1).max(6) },
}, guard(async (a) => {
  const r = (await call("POST", "hooks", a)) as { ok: boolean; saved: string[]; errors: string[] };
  const lines = [`Saved ${r.saved.length} hook(s): ${r.saved.join(", ") || "none"}.`];
  if (r.errors.length) lines.push(`Problems (fix and call propose_hooks again with ALL hooks):\n- ${r.errors.join("\n- ")}`);
  return text(lines.join("\n"), !r.ok && r.saved.length === 0);
}));

// ---------------------------------------------------------------- music library

server.registerTool("search_music", {
  description: "Search the creator's MUSIC LIBRARY (only music they're allowed to use: originals made by this app, free creator libraries, their own). Filter by genre (phonk, hip-hop, trap, lo-fi, pop, edm, house, cinematic, orchestral, acoustic, rock, ambient, funk, arabic) and/or mood (hype, aggressive, dark, mysterious, emotional, sad, inspiring, epic, chill, happy, funny, romantic, tense). Returns bpm, drops (seconds where the track hits), a loudness outline (0-10 every 4 s) and licence. guideOnly tracks are NOT exported (preview timing only). Empty filters = everything.",
  inputSchema: {
    query: z.string().max(80).optional(),
    genre: z.string().optional(),
    mood: z.string().optional(),
    minBpm: z.number().optional(),
    maxBpm: z.number().optional(),
  },
}, guard(async (a) => text(JSON.stringify(await call("POST", "music/search", a)))));

server.registerTool("use_music", {
  description: "Put a library track into the edit as a music layer (auto-ducked under speech). alignDropAt = OUTPUT second where the track's drop should hit (the payoff, the hook's reveal, the first big cut) — the start/offset are computed for you. Returns the beat times (output seconds) of the next 20 s so you can cut and place zooms/SFX ON the beat. Same id = replace. Typical volume: 0.15-0.3 under talking, 0.5-0.8 for music-only montage moments.",
  inputSchema: {
    trackId: z.string(),
    id: z.string().optional().describe("layer id, default music1, music2…"),
    start: z.number().min(0).optional().describe("output second the music starts (default 0)"),
    end: z.number().min(0).optional(),
    alignDropAt: z.number().min(0).optional(),
    dropIndex: z.number().int().min(0).optional().describe("which drop to align (default the first)"),
    volume: z.number().min(0).max(1.5).optional(),
    duckTo: z.number().min(0).max(1).optional(),
    fadeIn: z.number().min(0).max(10).optional(),
    fadeOut: z.number().min(0).max(10).optional(),
  },
}, guard(async (a) => {
  const r = (await call("POST", "music/use", a)) as Edit & { musicId?: string; start?: number; offset?: number; next20sBeats?: number[] };
  if (!r.ok) return editResult(r);
  const res = editResult(r);
  res.content.push({ type: "text", text: `Music layer "${r.musicId}" starts at ${r.start}s (track offset ${r.offset}s). Beats (output s): ${(r.next20sBeats ?? []).join(", ")}` });
  return res;
}));

server.registerTool("get_beats", {
  description: "Beat grid of a music layer in OUTPUT seconds (from/to window). subdivide 2 = also the half-beats (faster cutting), 4 = sixteenths. Also returns drop times. Use it to cut clips, start overlays, zooms and SFX exactly on the beat.",
  inputSchema: {
    musicId: z.string(),
    from: z.number().min(0).optional(),
    to: z.number().min(0).optional(),
    subdivide: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
  },
}, guard(async (a) => text(JSON.stringify(await call("POST", "music/beats", a)))));

server.registerTool("generate_music", {
  description: "Compose an ORIGINAL track right here (100% owned by the creator, never claimed) and add it to the library: phonk (cowbell + 808, hype/aggressive), upbeat (pop/dance), cinematic (epic build), lofi (chill). Takes ~5-20 s. Use when the library has nothing that fits. Returns the new track (then call use_music).",
  inputSchema: {
    style: z.enum(["phonk", "upbeat", "cinematic", "lofi"]),
    bpm: z.number().min(60).max(180).optional(),
    seconds: z.number().min(20).max(240).optional().describe("length (it loops if the video is longer)"),
  },
}, guard(async (a) => text(JSON.stringify(await call("POST", "music/generate", a)))));

// ---------------------------------------------------------------- voiceovers

server.registerTool("generate_voiceover", {
  description: "Speak a script with a natural AI voice made on this PC (free; Kokoro). Creates an audio media item, transcribes it (word timings → captions) and, if addAt is given, places it as a voice track at that OUTPUT second (the video lasts until it ends; music ducks under it). Voices: am_michael (confident male, default), am_fenrir (deep male), am_puck (upbeat male), af_heart (warm female), af_bella (bright female), af_nicole (soft female), bm_george (UK male), bf_emma (UK female). Keep each call to one section (≤ ~6000 characters); long scripts = several calls placed back to back. Takes roughly 1-3x the speech length.",
  inputSchema: {
    text: z.string().min(1).max(6000),
    voice: z.string().optional(),
    speed: z.number().min(0.7).max(1.3).optional(),
    addAt: z.number().min(0).optional(),
    id: z.string().optional().describe("voice layer id, default vo1, vo2…"),
    captions: z.boolean().optional(),
  },
}, guard(async (a) => text(JSON.stringify(await call("POST", "voiceover", a)))));

// ---------------------------------------------------------------- free visuals (faceless videos, B-roll)

server.registerTool("find_stock", {
  description: "Download free stock visuals INTO the project (returns mediaIds to use as clips / split-screen filler / image overlays). kind 'photo' works with no key (public-domain photos via Openverse, or Pexels when a key is set); kind 'video' (B-roll clips) needs the user's free Pexels key. Use short concrete search words ('city night traffic', 'ocean waves', 'person typing laptop'), not sentences. Orientation defaults to the project format. Each call downloads + analyses the files (photos ~5 s, videos ~20-60 s). Credits are kept for the description.",
  inputSchema: {
    query: z.string().min(1).max(100),
    kind: z.enum(["photo", "video"]).optional(),
    orientation: z.enum(["portrait", "landscape", "square"]).optional(),
    count: z.number().int().min(1).max(6).optional().describe("how many to download, default 3"),
  },
}, guard(async (a) => text(JSON.stringify(await call("POST", "stock", a)))));

server.registerTool("generate_image", {
  description: "Make an AI image INTO the project (returns a mediaId) — for faceless videos when no stock photo fits: specific scenes, concepts, illustrations. Write a vivid visual prompt (subject, setting, lighting, style, e.g. 'cinematic photo of a lone astronaut on a red desert at dusk, volumetric light'). Uses Hugging Face (if the user set a token) or Pollinations (free; adds a small corner watermark unless the user set a free token — the result says watermark:true). Never prompt for real people, logos or copyrighted characters. ~5-30 s each.",
  inputSchema: {
    prompt: z.string().min(3).max(600),
    orientation: z.enum(["portrait", "landscape", "square"]).optional(),
    seed: z.number().int().optional(),
  },
}, guard(async (a) => text(JSON.stringify(await call("POST", "image", a)))));

// ---------------------------------------------------------------- publish kit

server.registerTool("set_publish_info", {
  description: "Write the UPLOAD TEXT for this video (shown to the creator with copy buttons; credits for stock media are appended automatically). title: ≤70 chars, hook first, no clickbait lies. description: 2-4 short lines (what it is + why watch + one call to action). hashtags: 3-5 specific ones (no spaces). chapters (long-form only, OUTPUT seconds): first at 0, ≥3, each ≥10 s. Call it near the end of every edit.",
  inputSchema: {
    title: z.string().min(1).max(100),
    description: z.string().max(4500).optional(),
    hashtags: z.array(z.string()).max(15).optional(),
    chapters: z.array(z.object({ at: z.number().min(0), title: z.string().min(1).max(100) })).max(60).optional(),
    pinnedComment: z.string().max(500).optional().describe("optional question to pin as the first comment (drives replies)"),
  },
}, guard(async (a) => text(JSON.stringify(await call("POST", "publish", a)))));

server.registerTool("make_thumbnails", {
  description: "Render THUMBNAIL / cover options (YouTube 1280x720 or vertical cover 1080x1920 to match the project): the strongest face moments of the edit (or photos), punchy grade, big outlined title opposite the face, in 3 styles. You SEE the results — pick the best in your summary. text: 2-5 words that tease, not repeat, the title ('I QUIT', '$0 SETUP', 'DON'T DO THIS'). emoji optional (one). moments: optional [{mediaId, t}] SOURCE times to use instead of auto-picked faces. ~10-30 s.",
  inputSchema: {
    text: z.string().min(1).max(60),
    emoji: z.string().max(8).optional(),
    count: z.number().int().min(1).max(4).optional(),
    moments: z.array(z.object({ mediaId: z.string(), t: z.number().min(0) })).max(4).optional(),
  },
}, guard(async (a) => {
  const r = (await call("POST", "thumbnails", a)) as { thumbnails: { file: string }[]; frames: { t: number; base64: string }[] };
  return frames(`Thumbnail options (${r.thumbnails.map((t) => t.file).join(", ")}) — saved for the creator`, r.frames);
}));

// ---------------------------------------------------------------- footage fixes

server.registerTool("fix_footage", {
  description: "Repair a video's PICTURE before editing: stabilize (shaky handheld), denoise (grainy low light), color (fix dark/bright exposure, flat contrast, dull colours) and whiteBalance (remove an orange/blue/green tint). get_project shows each video's 'look' verdict. With only mediaId it applies exactly what the analysis recommends (white balance only for strong casts — a warm sunset or orange shirt is not a cast; check a frame before forcing whiteBalance). The fixed copy is used for preview and export from then on (the original is kept). Takes roughly 0.5-2x the clip length. undo true goes back to the original.",
  inputSchema: {
    mediaId: z.string(),
    stabilize: z.boolean().optional(),
    denoise: z.boolean().optional(),
    color: z.boolean().optional(),
    whiteBalance: z.boolean().optional(),
    sharpen: z.boolean().optional(),
    undo: z.boolean().optional(),
  },
}, guard(async (a) => text(JSON.stringify(await call("POST", "fix", a)))));

// ---------------------------------------------------------------- long video → clips (Night Shift scout)

server.registerTool("propose_clips", {
  description: "Night Shift scout: save the best moments of this long video as short-form clip ideas (replaces earlier ones). Each: id (c1, c2…), title, mediaId, in/out in SOURCE seconds (8-180 s; aim 20-60 s of usable speech), hook (the line or angle that stops the scroll), why, score 1-10. Each becomes its own vertical short, edited separately.",
  inputSchema: {
    clips: z.array(z.object({
      id: z.string(),
      title: z.string().max(80),
      mediaId: z.string(),
      in: z.number().min(0),
      out: z.number().min(0),
      hook: z.string().max(160),
      why: z.string().max(400),
      score: z.number().min(1).max(10),
    })).min(1).max(20),
  },
}, guard(async (a) => {
  const r = (await call("POST", "clip-ideas", a)) as { ok: boolean; saved: string[]; errors: string[] };
  const lines = [`Saved ${r.saved.length} clip idea(s): ${r.saved.join(", ") || "none"}.`];
  if (r.errors.length) lines.push(`Problems (fix and call propose_clips again with ALL clips):\n- ${r.errors.join("\n- ")}`);
  return text(lines.join("\n"), !r.ok && r.saved.length === 0);
}));

server.registerTool("auto_cut", {
  description: "Build the main clip list from one media file, removing silences (and optionally filler words like um/uh). REPLACES all current clips. Great first step for talking-head videos.",
  inputSchema: {
    mediaId: z.string(),
    method: z.enum(["words", "silence"]).optional().describe("words (default when a transcript exists) or silence"),
    minSilence: z.number().min(0.1).max(5).default(0.45).describe("pauses longer than this are cut"),
    padding: z.number().min(0).max(1).default(0.12).describe("seconds kept around speech"),
    removeFillers: z.boolean().default(true),
    from: z.number().min(0).optional(),
    to: z.number().min(0).optional(),
    punchIn: z.boolean().default(false).describe("every other jump cut gets a held 12% zoom on the face — hides jump cuts and adds energy (recommended for talking heads)"),
  },
}, guard(async (a) => editResult((await call("POST", "auto-cut", a)) as Edit)));

server.registerTool("speed_ramp", {
  description: "Turn one clip into a smooth speed ramp (it's split into short slices whose speeds ease along a curve). shape upDown = normal → fast → normal (montages, B-roll, transitions between scenes); up = speeds up into the next shot; down = slows to normal. peak 1.5-4 for speed-ups, 0.3-0.6 for a slow-motion moment. Speech in a ramped clip sounds sped up — use on B-roll / action / music moments.",
  inputSchema: {
    clipId: z.string(),
    peak: z.number().min(0.25).max(4).default(2.5),
    shape: z.enum(["upDown", "up", "down"]).default("upDown"),
    segments: z.number().int().min(3).max(10).default(6),
  },
}, guard(async (a) => editResult((await call("POST", "speed-ramp", a)) as Edit)));

server.registerTool("set_clips", {
  description: "Replace the main sequence (A-roll) with this exact list of clips, in playback order.",
  inputSchema: { clips: z.array(ClipSchema), reason },
}, guard(async (a) => editResult((await call("POST", "clips", a)) as Edit)));

server.registerTool("upsert_layers", {
  description: "Add or replace layers by id (same id = replace the whole layer). overlays: text/shape/image/video/faceCam/template. effects: zoom/shake/flash/... music & sfx: audio. voice: voiceover tracks (normally added by generate_voiceover). All times are OUTPUT seconds. Prefer use_music for library music (it aligns drops and returns beats).",
  inputSchema: {
    overlays: z.array(OverlaySchema).optional(),
    effects: z.array(EffectSchema).optional(),
    music: z.array(MusicSchema).optional(),
    sfx: z.array(SfxSchema).optional(),
    voice: z.array(VoiceSchema).optional(),
    reason,
  },
}, guard(async (a) => editResult((await call("POST", "layers", a)) as Edit)));

server.registerTool("remove_layers", {
  description: "Remove clips, overlays, effects, music or sfx by id.",
  inputSchema: { ids: z.array(z.string()).min(1), reason },
}, guard(async (a) => editResult((await call("POST", "remove", a)) as Edit)));

server.registerTool("update_settings", {
  description: "Deep-merge partial settings into the spec: format, background, captions, grade, retouch, reframe, audio (voiceVolume / enhanceVoice only), layout (split screen: {mode:'split', mediaId:<filler video>, ratio:0.5, fillerPosition:'bottom', divider?:'#fff'} — then set captions.y ≈ ratio), brand ({name, handle, avatar:<image mediaId>, colors:[...]}, used by subscribe/endScreen/postCard/socialHandle). Example: {\"captions\":{\"enabled\":true,\"style\":\"bold\"},\"grade\":{\"preset\":\"warm\"}}. Use null to clear an optional field.",
  inputSchema: {
    patch: z.record(z.string(), z.unknown()),
    reason,
  },
}, guard(async (a) => editResult((await call("POST", "settings", a)) as Edit)));

server.registerTool("set_spec", {
  description: "Replace the ENTIRE spec. Only for big restructures — prefer the targeted tools.",
  inputSchema: { spec: SpecSchema, reason },
}, guard(async (a) => editResult((await call("PUT", "spec", a)) as Edit)));

server.registerTool("undo", { description: "Undo the last change to the spec." }, guard(async () => text(String(await call("POST", "undo")))));

server.registerTool("set_status", {
  description: "Tell the app where you are. 'working' = you will keep going on your own (the app sends 'continue'); 'needs_user' = you asked the user a question (give 2-4 short options); 'done' = edit complete and self-reviewed. Call this at the END of every turn.",
  inputSchema: {
    state: z.enum(["working", "needs_user", "done"]),
    message: z.string().max(800),
    options: z.array(z.string().max(80)).max(4).optional(),
  },
}, guard(async (a) => text(String(await call("POST", "status", a)))));

await server.connect(new StdioServerTransport());
// Exit with the parent: when claude.exe closes our stdin, nothing else will ever talk to us.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
