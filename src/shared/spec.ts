// The Edit Spec: the one JSON document that fully describes an edit.
// Claude edits it through MCP tools; the Remotion composition renders it.
// All times are in SECONDS. "Output time" = time in the final video.
// Positions/sizes are NORMALIZED to the canvas (0..1, origin top-left, x/y = element centre).
import { z } from "zod";

export const FORMAT_PRESETS = {
  youtube: { width: 1920, height: 1080 },
  short: { width: 1080, height: 1920 }, // Shorts / Reels / TikTok
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 }, // Instagram feed 4:5
} as const;

export const FONT_NAMES = [
  "Inter", "Montserrat", "Poppins", "Anton", "Bebas Neue", "Oswald", "Bangers",
  "Playfair Display", "Permanent Marker", "Space Grotesk", "Cairo", "Tajawal", "JetBrains Mono",
] as const;
export const ANIMATIONS = [
  "none", "fade", "pop", "slideUp", "slideDown", "slideLeft", "slideRight",
  "zoomIn", "zoomOut", "blurIn", "bounce", "wipe", "spin", "typewriter",
  "rise", "elastic", "blurUp", "glitch", "stagger", "scaleBlur",
] as const;
export const TRANSITIONS = [
  "cut", "fade", "slide", "wipe", "flip", "clockWipe", "iris", "zoom", "blur", "whip", "pushCut",
  "glitch", "zoomPunch", "spin", "flash", "smoothSlide", "shutter",
] as const;
export const DIRECTIONS = ["left", "right", "up", "down"] as const;
export const CAPTION_STYLES = [
  "karaoke", "pop", "boxed", "minimal", "bold", "neon", "highlight", "typewriter",
  "single", "hormozi", "gradient", "outline",
] as const;
/** Camera move over a whole clip: slow push / pull / pan, or "punch" = a held zoom (hides jump cuts). */
export const MOTIONS = ["none", "pushIn", "pullOut", "panLeft", "panRight", "panUp", "panDown", "punch"] as const;
export const GRADE_PRESETS = [
  "none", "warm", "cool", "cinematic", "teal_orange", "vibrant", "moody", "bw", "vintage", "clean_bright",
] as const;
export const EFFECT_TYPES = ["zoom", "shake", "flash", "blur", "bw", "rgbSplit", "kenBurns"] as const;
export const SHAPES = [
  "rect", "circle", "ring", "line", "arrow", "underline", "triangle", "star", "highlight",
] as const;
export const TEMPLATES = [
  "titleCard", "lowerThird", "subscribe", "progressBar", "emojiPop", "callout", "counter",
  "listItem", "quote", "chapter", "socialHandle", "keyword", "countdown",
  "postCard", "chat", "versus", "endScreen", "background", "question",
] as const;
export const LAYOUT_MODES = ["full", "split"] as const;
export const SFX_NAMES = ["whoosh", "pop", "click", "ding", "riser", "boom", "swoosh", "typing"] as const;
export const REFRAME_MODES = ["auto", "fill", "fit", "blur", "face"] as const;

const sec = z.number().min(0);
const norm = z.number().min(-0.5).max(1.5); // slightly outside canvas allowed for off-screen starts
const color = z.string().min(1).max(64);

export const AnimSchema = z.object({
  in: z.enum(ANIMATIONS).default("pop"),
  out: z.enum(ANIMATIONS).default("fade"),
  duration: z.number().min(0).max(3).default(0.35),
});

const layerBase = {
  id: z.string().min(1),
  start: sec,
  end: sec,
  z: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  anim: AnimSchema.prefault({}),
};

export const TextStyleSchema = z.object({
  font: z.enum(FONT_NAMES).default("Montserrat"),
  size: z.number().min(8).max(600).default(80), // px on the output canvas
  weight: z.number().min(100).max(900).default(800),
  color: color.default("#ffffff"),
  gradient: z.tuple([color, color]).optional(), // text gradient fill (overrides color)
  strokeColor: color.optional(),
  strokeWidth: z.number().min(0).max(40).default(0),
  shadow: z.boolean().default(true),
  background: color.optional(), // pill/box behind the text
  radius: z.number().min(0).max(200).default(18),
  align: z.enum(["left", "center", "right"]).default("center"),
  uppercase: z.boolean().default(false),
  italic: z.boolean().default(false),
  letterSpacing: z.number().min(-10).max(40).default(0),
  lineHeight: z.number().min(0.6).max(3).default(1.1),
});

export const TextOverlaySchema = z.object({
  type: z.literal("text"),
  ...layerBase,
  text: z.string().min(1).max(500),
  x: norm.default(0.5),
  y: norm.default(0.5),
  maxWidth: z.number().min(0.05).max(1).default(0.85),
  rotation: z.number().min(-180).max(180).default(0),
  style: TextStyleSchema.prefault({}),
});

export const ShapeOverlaySchema = z.object({
  type: z.literal("shape"),
  ...layerBase,
  shape: z.enum(SHAPES),
  x: norm.default(0.5),
  y: norm.default(0.5),
  w: z.number().min(0).max(2).default(0.3),
  h: z.number().min(0).max(2).default(0.1),
  // line / arrow: drawn from (x,y) to (x2,y2)
  x2: norm.optional(),
  y2: norm.optional(),
  color: color.default("#FFD400"),
  fill: z.boolean().default(true),
  strokeWidth: z.number().min(0).max(80).default(8),
  radius: z.number().min(0).max(500).default(0),
  rotation: z.number().min(-180).max(180).default(0),
  draw: z.boolean().default(false), // animate the stroke being drawn
});

export const ImageOverlaySchema = z.object({
  type: z.literal("image"),
  ...layerBase,
  mediaId: z.string().min(1),
  x: norm.default(0.5),
  y: norm.default(0.5),
  w: z.number().min(0.01).max(2).default(0.4), // height follows the image aspect ratio
  shape: z.enum(["rect", "circle"]).default("rect"),
  radius: z.number().min(0).max(500).default(24),
  border: color.optional(),
  shadow: z.boolean().default(true),
  kenBurns: z.boolean().default(false),
});

export const VideoOverlaySchema = z.object({
  type: z.literal("video"), // B-roll or picture-in-picture
  ...layerBase,
  mediaId: z.string().min(1),
  in: sec.default(0), // where to start inside the source
  speed: z.number().min(0.25).max(4).default(1),
  fullscreen: z.boolean().default(false),
  x: norm.default(0.5),
  y: norm.default(0.5),
  w: z.number().min(0.05).max(2).default(0.45),
  shape: z.enum(["rect", "circle"]).default("rect"),
  radius: z.number().min(0).max(500).default(24),
  border: color.optional(),
  muted: z.boolean().default(true),
  volume: z.number().min(0).max(2).default(1),
});

export const FaceCamOverlaySchema = z.object({
  type: z.literal("faceCam"), // circular bubble of the speaker's face (from the main clips), e.g. over B-roll
  ...layerBase,
  x: norm.default(0.82),
  y: norm.default(0.8),
  size: z.number().min(0.05).max(1).default(0.28), // diameter relative to canvas width
  border: color.default("#ffffff"),
  zoom: z.number().min(1).max(4).default(1.6),
});

export const TemplateOverlaySchema = z.object({
  type: z.literal("template"),
  ...layerBase,
  template: z.enum(TEMPLATES),
  x: norm.optional(),
  y: norm.optional(),
  scale: z.number().min(0.1).max(5).default(1),
  accent: color.default("#FFD400"),
  font: z.enum(FONT_NAMES).optional(),
  // Template-specific fields; see catalog.ts for what each template reads.
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const OverlaySchema = z.discriminatedUnion("type", [
  TextOverlaySchema,
  ShapeOverlaySchema,
  ImageOverlaySchema,
  VideoOverlaySchema,
  FaceCamOverlaySchema,
  TemplateOverlaySchema,
]);

export const ReframeSchema = z.object({
  mode: z.enum(REFRAME_MODES).default("auto"),
  zoom: z.number().min(1).max(4).default(1), // extra zoom on top of the fit
  offsetX: z.number().min(-1).max(1).default(0), // nudge the crop window (-1..1)
  offsetY: z.number().min(-1).max(1).default(0),
});

export const ClipSchema = z.object({
  id: z.string().min(1),
  mediaId: z.string().min(1),
  in: sec, // source start (s)
  out: sec, // source end (s)
  speed: z.number().min(0.25).max(4).default(1),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
  flipX: z.boolean().default(false),
  // Transition FROM the previous clip INTO this one (ignored on the first clip).
  transition: z
    .object({
      type: z.enum(TRANSITIONS).default("fade"),
      duration: z.number().min(0.05).max(3).default(0.4),
      direction: z.enum(DIRECTIONS).default("left"),
    })
    .optional(),
  reframe: ReframeSchema.partial().optional(), // per-clip override of the global reframe
  // Camera move over the clip, centred on the face when there is one. amount = extra zoom (0.1 = 10%).
  motion: z
    .object({ type: z.enum(MOTIONS).default("none"), amount: z.number().min(0).max(0.5).default(0.1) })
    .optional(),
});

export const CaptionsSchema = z.object({
  enabled: z.boolean().default(false),
  style: z.enum(CAPTION_STYLES).default("bold"),
  font: z.enum(FONT_NAMES).default("Montserrat"),
  size: z.number().min(16).max(300).default(84),
  color: color.default("#ffffff"),
  highlightColor: color.default("#FFD400"),
  strokeColor: color.default("#000000"),
  strokeWidth: z.number().min(0).max(30).default(10),
  background: color.optional(),
  y: z.number().min(0.05).max(0.95).default(0.72), // vertical centre of the caption block
  maxWordsPerPage: z.number().int().min(1).max(12).default(3),
  uppercase: z.boolean().default(true),
  // Word-level styling: match a word (case-insensitive) or the word spoken at output time `at`.
  emphasis: z
    .array(
      z.object({
        word: z.string().optional(),
        at: sec.optional(),
        color: color.optional(),
        emoji: z.string().max(16).optional(),
        scale: z.number().min(0.5).max(3).default(1.25),
      }),
    )
    .default([]),
  corrections: z.array(z.object({ from: z.string().min(1), to: z.string() })).default([]),
  hide: z.array(z.object({ start: sec, end: sec })).default([]), // ranges with no captions (e.g. over a title card)
});

export const MusicSchema = z.object({
  id: z.string().min(1),
  mediaId: z.string().min(1),
  start: sec.default(0), // output time the music starts
  end: sec.optional(), // output time it stops (default: end of video)
  offset: sec.default(0), // where to start inside the music file
  volume: z.number().min(0).max(1.5).default(0.25),
  fadeIn: z.number().min(0).max(10).default(1),
  fadeOut: z.number().min(0).max(10).default(2),
  duckTo: z.number().min(0).max(1).default(0.35), // multiplier while someone is talking (1 = no ducking)
  loop: z.boolean().default(true),
  // Guide track: heard in the editor's preview to time the edit, NEVER rendered into the export.
  // For songs you can't license yourself — add them later in Instagram/TikTok/YouTube's own music picker.
  guide: z.boolean().default(false),
  title: z.string().max(120).optional(), // shown in the export note for guide tracks
});

/** A voiceover (or any narration) track. Its words drive captions and duck the music like on-camera speech. */
export const VoiceSchema = z.object({
  id: z.string().min(1),
  mediaId: z.string().min(1),
  start: sec.default(0), // output time it starts
  offset: sec.default(0), // where to start inside the audio file
  end: sec.optional(), // output time it stops (default: end of the file)
  volume: z.number().min(0).max(2).default(1),
  captions: z.boolean().default(true),
});

export const SfxSchema = z.object({
  id: z.string().min(1),
  sound: z.string().min(1), // one of SFX_NAMES, or a mediaId of an uploaded audio file
  at: sec,
  volume: z.number().min(0).max(2).default(0.6),
});

export const GradeSchema = z.object({
  preset: z.enum(GRADE_PRESETS).default("none"),
  // Manual adjustments are applied ON TOP of the preset (1 / 0 = neutral).
  brightness: z.number().min(0.3).max(2).default(1),
  contrast: z.number().min(0.3).max(2).default(1),
  saturation: z.number().min(0).max(3).default(1),
  temperature: z.number().min(-1).max(1).default(0), // - cool, + warm
  tint: z.number().min(-1).max(1).default(0), // - green, + magenta
  vignette: z.number().min(0).max(1).default(0),
  grain: z.number().min(0).max(1).default(0),
  fade: z.number().min(0).max(1).default(0), // lifted blacks / matte look
  lightLeak: z.number().min(0).max(1).default(0),
});

export const EffectSchema = z.object({
  id: z.string().min(1),
  type: z.enum(EFFECT_TYPES),
  start: sec,
  end: sec,
  intensity: z.number().min(0).max(1).default(0.5),
  focus: z.union([z.literal("face"), z.literal("center"), z.object({ x: norm, y: norm })]).default("face"),
  ease: z.enum(["snap", "smooth"]).default("snap"),
});

/**
 * Screen layout. "split" = the clips (the speaker) fill one part of the frame and a looping filler video
 * (gameplay, satisfying footage, B-roll) fills the rest — the classic Shorts split-screen.
 */
export const LayoutSchema = z.object({
  mode: z.enum(LAYOUT_MODES).default("full"),
  mediaId: z.string().min(1).optional(), // the filler video (split mode)
  in: sec.default(0), // where the filler starts playing (seconds into it); it loops
  fillerPosition: z.enum(["bottom", "top"]).default("bottom"),
  ratio: z.number().min(0.25).max(0.75).default(0.5), // share of the height the clips get
  fillerVolume: z.number().min(0).max(1).default(0),
  divider: color.optional(), // thin line between the halves
});

/** The creator's identity, reused by templates (subscribe, postCard, endScreen, socialHandle, chat). */
export const BrandSchema = z.object({
  name: z.string().max(60).optional(), // display name
  handle: z.string().max(40).optional(), // @handle
  avatar: z.string().min(1).optional(), // mediaId of the profile picture (an image)
  colors: z.array(color).max(4).default([]), // brand palette; the first one is the accent
});

export const SpecSchema = z.object({
  version: z.literal(1).default(1),
  format: z
    .object({
      preset: z.enum(["youtube", "short", "square", "portrait", "custom"]).default("youtube"),
      width: z.number().int().min(64).max(3840).default(1920),
      height: z.number().int().min(64).max(3840).default(1080),
      fps: z.number().int().min(12).max(60).default(30),
    })
    .prefault({}),
  background: color.default("#000000"),
  clips: z.array(ClipSchema).default([]),
  overlays: z.array(OverlaySchema).default([]),
  captions: CaptionsSchema.prefault({}),
  audio: z
    .object({
      voiceVolume: z.number().min(0).max(2).default(1),
      enhanceVoice: z.boolean().default(false), // denoise + loudness-normalise the speech
      music: z.array(MusicSchema).default([]),
      sfx: z.array(SfxSchema).default([]),
      voice: z.array(VoiceSchema).default([]),
    })
    .prefault({}),
  grade: GradeSchema.prefault({}),
  effects: z.array(EffectSchema).default([]),
  retouch: z
    .object({
      skinSmooth: z.number().min(0).max(1).default(0),
      faceLight: z.number().min(0).max(1).default(0), // soft key light on the face
    })
    .prefault({}),
  reframe: ReframeSchema.prefault({}),
  layout: LayoutSchema.prefault({}),
  brand: BrandSchema.prefault({}),
});

export type Spec = z.infer<typeof SpecSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type Brand = z.infer<typeof BrandSchema>;
export type SpecInput = z.input<typeof SpecSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
export type ShapeOverlay = z.infer<typeof ShapeOverlaySchema>;
export type ImageOverlay = z.infer<typeof ImageOverlaySchema>;
export type VideoOverlay = z.infer<typeof VideoOverlaySchema>;
export type FaceCamOverlay = z.infer<typeof FaceCamOverlaySchema>;
export type TemplateOverlay = z.infer<typeof TemplateOverlaySchema>;
export type Captions = z.infer<typeof CaptionsSchema>;
export type Grade = z.infer<typeof GradeSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
export type Music = z.infer<typeof MusicSchema>;
export type Reframe = z.infer<typeof ReframeSchema>;
export type Anim = z.infer<typeof AnimSchema>;
export type TextStyle = z.infer<typeof TextStyleSchema>;
export type FontName = (typeof FONT_NAMES)[number];

export function parseSpec(input: unknown): Spec {
  return SpecSchema.parse(input);
}

export function emptySpec(preset: keyof typeof FORMAT_PRESETS = "youtube"): Spec {
  return parseSpec({ format: { preset, ...FORMAT_PRESETS[preset] } });
}

// ---- Media + analysis that the composition needs alongside the spec ----

export type MediaInfo = {
  id: string;
  kind: "video" | "audio" | "image";
  name: string;
  src: string; // full-quality URL (used for final render)
  previewSrc?: string; // light H.264 proxy (used in the browser preview)
  enhancedSrc?: string; // same media with cleaned-up voice audio
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
};

export type Word = { text: string; start: number; end: number }; // source time, seconds

// Primary face per sample. Each entry: [cx, cy, w, h, reX, reY, leX, leY, mrX, mrY, mlX, mlY]
// (normalized to the source frame; re/le = right/left eye, mr/ml = mouth corners) or null when no face.
export type FaceTrack = { sampleFps: number; samples: (number[] | null)[] };

export type MediaAnalysis = { words?: Word[]; faces?: FaceTrack; language?: string };

export type CompositionProps = {
  spec: Spec;
  media: Record<string, MediaInfo>;
  analysis: Record<string, MediaAnalysis>;
  preview: boolean; // true in the browser player -> use proxies
  sfxBaseUrl: string;
  videoEngine?: "offthread" | "webcodecs"; // decoder used for video layers (see remotion/VideoTag.tsx)
};
