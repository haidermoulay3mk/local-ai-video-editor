// Static catalog: the look values behind presets, the CSS font families, and the
// human-readable docs Claude receives so it knows what every option does.
import type { FontName } from "./spec";

export const FONT_CSS: Record<FontName, string> = {
  Inter: "Inter Variable",
  Montserrat: "Montserrat Variable",
  Poppins: "Poppins",
  Anton: "Anton",
  "Bebas Neue": "Bebas Neue",
  Oswald: "Oswald Variable",
  Bangers: "Bangers",
  "Playfair Display": "Playfair Display Variable",
  "Permanent Marker": "Permanent Marker",
  "Space Grotesk": "Space Grotesk Variable",
  Cairo: "Cairo Variable",
  Tajawal: "Tajawal",
  "JetBrains Mono": "JetBrains Mono Variable",
};

/** CSS font stack: chosen font, Arabic-capable fallback, then emoji. */
export function fontStack(font: FontName): string {
  return `"${FONT_CSS[font]}", "Cairo Variable", "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
}

export type GradeValues = {
  brightness: number; contrast: number; saturation: number; temperature: number; tint: number;
  vignette: number; grain: number; fade: number; lightLeak: number; sepia: number;
};

const NEUTRAL: GradeValues = {
  brightness: 1, contrast: 1, saturation: 1, temperature: 0, tint: 0,
  vignette: 0, grain: 0, fade: 0, lightLeak: 0, sepia: 0,
};

export const GRADE_VALUES: Record<string, GradeValues> = {
  none: NEUTRAL,
  warm: { ...NEUTRAL, temperature: 0.3, saturation: 1.08, contrast: 1.04 },
  cool: { ...NEUTRAL, temperature: -0.3, contrast: 1.05 },
  cinematic: { ...NEUTRAL, contrast: 1.14, saturation: 0.88, temperature: 0.12, vignette: 0.4, fade: 0.06 },
  teal_orange: { ...NEUTRAL, contrast: 1.15, saturation: 1.12, temperature: 0.18, tint: -0.12, vignette: 0.2 },
  vibrant: { ...NEUTRAL, saturation: 1.32, contrast: 1.08, brightness: 1.03 },
  moody: { ...NEUTRAL, brightness: 0.92, contrast: 1.16, saturation: 0.78, temperature: -0.12, vignette: 0.5 },
  bw: { ...NEUTRAL, saturation: 0, contrast: 1.22 },
  vintage: { ...NEUTRAL, sepia: 0.3, saturation: 0.85, fade: 0.14, grain: 0.35, vignette: 0.3, temperature: 0.15 },
  clean_bright: { ...NEUTRAL, brightness: 1.07, contrast: 1.03, saturation: 1.06 },
};

/** Preset first, manual adjustments layered on top (multiplicative / additive). */
export function resolveGrade(g: {
  preset: string; brightness: number; contrast: number; saturation: number; temperature: number;
  tint: number; vignette: number; grain: number; fade: number; lightLeak: number;
}): GradeValues {
  const p = GRADE_VALUES[g.preset] ?? NEUTRAL;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    brightness: p.brightness * g.brightness,
    contrast: p.contrast * g.contrast,
    saturation: p.saturation * g.saturation,
    temperature: clamp(p.temperature + g.temperature, -1, 1),
    tint: clamp(p.tint + g.tint, -1, 1),
    vignette: clamp(p.vignette + g.vignette, 0, 1),
    grain: clamp(p.grain + g.grain, 0, 1),
    fade: clamp(p.fade + g.fade, 0, 1),
    lightLeak: clamp(p.lightLeak + g.lightLeak, 0, 1),
    sepia: p.sepia,
  };
}

/** What each motion-graphics template reads from `props` (all optional unless marked). */
export const TEMPLATE_DOCS: Record<string, { use: string; props: Record<string, string> }> = {
  titleCard: {
    use: "Big animated title, centred (hook / intro / section opener).",
    props: { title: "REQUIRED text", subtitle: "smaller line under it", style: "'bold' | 'minimal' | 'glitch'", backdrop: "true = dark backdrop behind it" },
  },
  lowerThird: {
    use: "Name + role bar in the lower third (introduce the speaker).",
    props: { name: "REQUIRED", title: "role / handle", side: "'left' | 'right'" },
  },
  subscribe: {
    use: "Animated SUBSCRIBE / FOLLOW button with a cursor click and bell.",
    props: { label: "button text, default SUBSCRIBE", channel: "channel name shown next to it" },
  },
  progressBar: {
    use: "Thin bar that fills over the layer's duration (retention bar). Usually start=0, end=video end.",
    props: { position: "'top' | 'bottom'", thickness: "px, default 10" },
  },
  emojiPop: { use: "Emoji that pops in with a bounce.", props: { emoji: "REQUIRED e.g. 🔥", size: "px, default 160" } },
  callout: {
    use: "Label with an arrow pointing at a spot (point at something on screen).",
    props: { text: "REQUIRED", targetX: "0-1 where the arrow points", targetY: "0-1" },
  },
  counter: {
    use: "Number counting up (stats, money, followers).",
    props: { to: "REQUIRED number", from: "default 0", prefix: "e.g. $", suffix: "e.g. K or %", decimals: "default 0", label: "caption under the number" },
  },
  listItem: { use: "Numbered list entry ('3 tips' videos).", props: { number: "REQUIRED", text: "REQUIRED" } },
  quote: { use: "Stylised quote card.", props: { text: "REQUIRED", author: "attribution" } },
  chapter: { use: "Chapter / section marker.", props: { title: "REQUIRED", number: "optional chapter number" } },
  socialHandle: {
    use: "@handle badge (no platform logos — trademark-safe).",
    props: { handle: "REQUIRED e.g. @yourname", platform: "label text e.g. Instagram" },
  },
  keyword: {
    use: "One word SLAMS onto the screen with shake (emphasise a key word).",
    props: { text: "REQUIRED", rotate: "degrees, default -4" },
  },
  countdown: { use: "3-2-1 countdown that fills the layer duration.", props: { from: "default 3" } },
  postCard: {
    use: "Story/post card (forum thread or social post) for faceless story videos — card pops up, text types on, counts tick up. Generic design, no logos. Keep it on screen while the voice reads it.",
    props: {
      style: "'forum' (title + body + votes) | 'social' (short post + likes/reposts/views)",
      title: "forum: the post title (REQUIRED for forum)", body: "forum: body text (clamped to maxLines, default 7)",
      text: "social: the post text (REQUIRED for social)", user: "poster name (default: brand name)", handle: "social: @handle",
      community: "forum: community/sub name shown on top, e.g. 'r/AmItheAsshole' or 'Stories'", time: "e.g. '5h ago'",
      votes: "number (likes for social)", comments: "number", reposts: "social", views: "social",
      theme: "'light' (forum default) | 'dark' (social default)", verified: "social: true = check badge", avatar: "image mediaId",
    },
  },
  chat: {
    use: "Text-message conversation: bubbles pop in one by one with typing dots before replies; auto-scrolls. Faceless 'text story' format. Add a 'pop' sfx per message (times from the layer start: 0.35 + i × perMessage).",
    props: {
      messages: "REQUIRED 'me: hey|Sam: what?|me: …' — 'me' lines on the right, any other name on the left (several names = group chat)",
      contact: "header name (default: first other speaker)", perMessage: "seconds between messages (default: spread over the layer)",
      theme: "'dark' | 'light'", meColor: "my bubble colour, default #0A84FF", status: "under my last bubble, default Delivered",
      height: "panel height 0-1 of the frame, default 0.64", contactAvatar: "image mediaId",
    },
  },
  versus: {
    use: "Full-screen 'A vs B' comparison: two diagonal panels slide in, VS badge slams in with a shockwave. Comparisons, debates, 'which is better'.",
    props: { left: "REQUIRED label", right: "REQUIRED label", leftSub: "small line", rightSub: "small line", leftColor: "default red", rightColor: "default blue", leftImage: "image mediaId", rightImage: "image mediaId" },
  },
  endScreen: {
    use: "Last 5-10 s: darkened background, 'watch next' slot(s) (YouTube end-screen placeholders), profile picture + handle + call to action.",
    props: { title: "default WATCH NEXT", next: "slot label", next2: "second slot label (landscape)", cta: "button text (default FOLLOW FOR PART 2 / SUBSCRIBE)", handle: "default: brand handle", avatar: "image mediaId (default: brand avatar)" },
  },
  background: {
    use: "Full-screen ANIMATED background for faceless / text-only videos or intro cards (covers the clips under it — use where there is no footage, z below other layers).",
    props: { style: "'gradient' (drifting colour blobs) | 'particles' | 'grid' (retro synthwave) | 'aurora' | 'rays' (rotating sunburst)", color2: "second colour (accent is the first)", color3: "base/dark colour", speed: "default 1" },
  },
  question: {
    use: "Q&A sticker card ('Ask me anything' header + the question) — answer-a-question videos.",
    props: { text: "REQUIRED the question", header: "default 'Ask me anything'", avatar: "image mediaId (default: brand avatar)", color2: "header gradient end", rotate: "degrees, default -3" },
  },
};

export const CAPTION_STYLE_DOCS: Record<string, string> = {
  karaoke: "Whole line visible, the spoken word lights up in highlightColor.",
  pop: "Words pop in one by one as they are spoken.",
  boxed: "White text on a dark rounded box; spoken word gets a coloured pill.",
  minimal: "Small clean sentence-case subtitles, no highlight. Good for calm/educational.",
  bold: "Heavy uppercase with thick stroke; spoken word bigger + highlightColor (Hormozi-style).",
  neon: "Glowing text; spoken word glows in highlightColor.",
  highlight: "Spoken word gets a coloured rounded background (Submagic-style).",
  typewriter: "Characters type on as words are spoken.",
  single: "ONE big word at a time, popping in as it's spoken — the fast TikTok look (ignores maxWordsPerPage).",
  hormozi: "White heavy words; the spoken word pops bigger and cycles yellow/green/red — classic high-retention look.",
  gradient: "Spoken word filled with a highlightColor→pink gradient and a soft glow — modern/aesthetic.",
  outline: "Hollow outlined letters; the spoken word fills solid in highlightColor — clean editorial look.",
};

export const MOTION_DOCS: Record<string, string> = {
  none: "static (default)",
  pushIn: "slow push in over the whole clip (adds life to talking heads, B-roll and photos)",
  pullOut: "slow pull back over the clip (reveals, endings)",
  panLeft: "slow pan left", panRight: "slow pan right", panUp: "slow tilt up", panDown: "slow tilt down",
  punch: "held zoom for the whole clip — alternate punch/none on consecutive jump cuts to hide the cut",
};

export const TRANSITION_DOCS: Record<string, string> = {
  cut: "hard cut (default when no transition)",
  fade: "cross-dissolve",
  slide: "new clip slides in (direction)",
  wipe: "wipe reveal (direction)",
  flip: "3D card flip (direction)",
  clockWipe: "radial clock wipe",
  iris: "circle iris reveal",
  zoom: "zoom-through: old clip zooms in + fades, new clip settles from zoomed",
  blur: "blur dissolve",
  whip: "fast whip-pan with motion blur (direction)",
  pushCut: "punchy scale push with a white flash",
  glitch: "digital glitch: RGB split, slice jumps and flicker (tech, gaming, edits) — 0.25-0.4s",
  zoomPunch: "fast zoom INTO the cut and back out of it with motion blur — the most-used creator transition, 0.3-0.45s",
  spin: "spin with motion blur and zoom (energetic montages) — 0.4-0.6s",
  flash: "white/warm light flash through the cut (beat drops, reveals, before/after) — 0.3-0.5s",
  smoothSlide: "both shots push together with motion blur and a slight scale dip (direction) — smooth vlog transition",
  shutter: "horizontal shutter bars close and open (clean, stylish) — 0.4-0.6s",
};

export const EFFECT_DOCS: Record<string, string> = {
  zoom: "punch-in zoom (ease 'snap' = instant punch, 'smooth' = gradual); intensity 0.5 ≈ 1.25x",
  shake: "camera shake (impact moments)",
  flash: "white flash fading out (beat drops, cuts)",
  blur: "blur the main video (e.g. behind a title card)",
  bw: "black & white for the range",
  rgbSplit: "chromatic aberration glitch",
  kenBurns: "slow continuous zoom-in for the range (adds motion to static shots)",
};

export const SFX_DOCS: Record<string, string> = {
  whoosh: "airy swoosh — pair with transitions / text sliding in",
  swoosh: "short downward swoosh",
  pop: "bubbly pop — pair with emoji / text pops",
  click: "UI click — pair with the subscribe button",
  ding: "bright bell ding — success / reveal",
  riser: "2s rising tension — before a reveal",
  boom: "deep impact — keyword slams, big moments",
  typing: "keyboard clatter — typewriter text",
};
