// Colour grade / lighting overlays and timed camera effects for the main video.
import type React from "react";
import type { CSSProperties } from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import { resolveGrade } from "../shared/catalog";
import type { Effect, Spec } from "../shared/spec";

type FacePos = { x: number; y: number; w: number; h: number } | null;

export function gradeFilter(spec: Spec): string {
  const g = resolveGrade(spec.grade);
  const parts = [`brightness(${g.brightness.toFixed(3)})`, `contrast(${g.contrast.toFixed(3)})`, `saturate(${g.saturation.toFixed(3)})`];
  if (g.sepia > 0) parts.push(`sepia(${g.sepia})`);
  return parts.join(" ");
}

export const GradeOverlays: React.FC<{ spec: Spec; face: FacePos }> = ({ spec, face }) => {
  const frame = useCurrentFrame();
  const g = resolveGrade(spec.grade);
  const { width: W, height: H, fps } = spec.format;
  const layers: React.ReactNode[] = [];
  const fill = (key: string, style: CSSProperties) => layers.push(<AbsoluteFill key={key} style={style} />);

  if (g.temperature !== 0) {
    fill("temp", {
      background: g.temperature > 0 ? "#ff9640" : "#3c8cff",
      mixBlendMode: "soft-light",
      opacity: Math.abs(g.temperature) * 0.55,
    });
  }
  if (g.tint !== 0) {
    fill("tint", { background: g.tint > 0 ? "#ff3cc8" : "#3cff8a", mixBlendMode: "soft-light", opacity: Math.abs(g.tint) * 0.4 });
  }
  if (g.fade > 0) fill("fade", { background: "rgb(46,46,52)", mixBlendMode: "lighten", opacity: g.fade });
  if (face && spec.retouch.faceLight > 0) {
    const r = Math.max(face.w, face.h) * 1.4;
    fill("keylight", {
      background: `radial-gradient(circle ${r}px at ${face.x - face.w * 0.15}px ${face.y - face.h * 0.1}px, rgba(255,244,230,0.95), rgba(255,244,230,0) 100%)`,
      mixBlendMode: "soft-light",
      opacity: spec.retouch.faceLight * 0.75,
    });
  }
  if (g.lightLeak > 0) {
    const t = frame / fps;
    const x = 18 + 26 * Math.sin(t * 0.37), y = 12 + 18 * Math.cos(t * 0.29);
    fill("leak", {
      background:
        `radial-gradient(circle at ${x}% ${y}%, rgba(255,140,60,0.95), rgba(255,140,60,0) 42%),` +
        `radial-gradient(circle at ${100 - x}% ${92 - y}%, rgba(255,60,120,0.8), rgba(255,60,120,0) 38%)`,
      mixBlendMode: "screen",
      opacity: g.lightLeak * 0.6,
    });
  }
  if (g.vignette > 0) {
    fill("vignette", {
      background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 48%, rgba(0,0,0,${(0.88 * g.vignette).toFixed(3)}) 100%)`,
    });
  }
  if (g.grain > 0) {
    // A pre-made noise tile shifted randomly each frame: looks like film grain, costs ~nothing
    // (a full-frame SVG turbulence filter per frame was the slowest layer in the engine test).
    const tile = noiseTile();
    if (tile) {
      fill("grain", {
        backgroundImage: `url(${tile})`,
        backgroundSize: `${Math.round(Math.max(W, H) / 7.5)}px`,
        backgroundPosition: `${Math.floor(random(`gx${frame}`) * 256)}px ${Math.floor(random(`gy${frame}`) * 256)}px`,
        mixBlendMode: "overlay",
        opacity: g.grain * 0.55,
        imageRendering: "pixelated",
      });
    }
  }
  return <>{layers}</>;
};

let tileCache: string | null = null;
function noiseTile(): string | null {
  if (tileCache) return tileCache;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(256, 256);
  let seed = 1234567; // deterministic -> identical grain in preview and render
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const v = 128 + ((seed / 0x7fffffff) - 0.5) * 230;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  tileCache = c.toDataURL("image/png");
  return tileCache;
}

// ------------------------------------------------------------------ timed effects

export type EffectState = {
  transform: string;
  origin: string;
  filter: string;
  flash: number;
  rgbSplit: number; // px offset
};

export function effectsAt(effects: Effect[], t: number, fps: number, W: number, H: number, face: FacePos): EffectState {
  const st: EffectState = { transform: "", origin: `${W / 2}px ${H / 2}px`, filter: "", flash: 0, rgbSplit: 0 };
  const frame = Math.round(t * fps);
  for (const e of effects) {
    if (t < e.start || t >= e.end) continue;
    const local = t - e.start;
    const len = Math.max(1 / fps, e.end - e.start);
    const focus =
      e.focus === "face" && face ? { x: face.x, y: face.y }
        : typeof e.focus === "object" ? { x: e.focus.x * W, y: e.focus.y * H }
          : { x: W / 2, y: H / 2 };
    switch (e.type) {
      case "zoom": {
        const target = 1 + 0.5 * e.intensity;
        const s =
          e.ease === "snap"
            ? interpolate(local, [0, 0.08, Math.max(0.09, len - 0.06), len], [1, target, target, 1], { extrapolateRight: "clamp" })
            : interpolate(local, [0, len], [1, target], { easing: (x) => x * x * (3 - 2 * x) });
        st.transform += ` scale(${s.toFixed(4)})`;
        st.origin = `${focus.x}px ${focus.y}px`;
        break;
      }
      case "kenBurns": {
        const s = 1 + 0.15 * e.intensity * (local / len);
        st.transform += ` scale(${s.toFixed(4)})`;
        st.origin = `${focus.x}px ${focus.y}px`;
        break;
      }
      case "shake": {
        const amp = 26 * e.intensity * (1 - local / len);
        const dx = (random(`sx${frame}`) - 0.5) * 2 * amp;
        const dy = (random(`sy${frame}`) - 0.5) * 2 * amp;
        // scale slightly so the shaking never reveals the canvas edge
        st.transform += ` translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${(1 + (amp * 2.2) / Math.min(W, H)).toFixed(4)})`;
        break;
      }
      case "flash":
        st.flash = Math.max(st.flash, interpolate(local, [0, Math.min(0.35, len)], [e.intensity, 0], { extrapolateRight: "clamp" }));
        break;
      case "blur":
        st.filter += ` blur(${(18 * e.intensity).toFixed(1)}px)`;
        break;
      case "bw":
        st.filter += " grayscale(1)";
        break;
      case "rgbSplit":
        st.rgbSplit = Math.max(st.rgbSplit, 4 + 14 * e.intensity * (0.6 + 0.4 * random(`rgb${frame}`)));
        break;
    }
  }
  return st;
}

/** SVG filter used for the chromatic-aberration (rgbSplit) effect. */
export const RgbSplitFilter: React.FC<{ id: string; offset: number }> = ({ id, offset }) => (
  <svg width="0" height="0" style={{ position: "absolute" }}>
    <filter id={id} colorInterpolationFilters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
      <feOffset in="r" dx={offset} dy="0" result="r2" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="gb" />
      <feOffset in="gb" dx={-offset} dy="0" result="gb2" />
      <feBlend in="r2" in2="gb2" mode="screen" />
    </filter>
  </svg>
);
