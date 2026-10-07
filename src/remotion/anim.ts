// Entrance / exit animation for any timed layer.
import type { CSSProperties } from "react";
import { interpolate, random, spring } from "remotion";
import type { Anim } from "../shared/spec";

export type AnimState = {
  style: CSSProperties; // opacity / filter / clipPath
  transform: string; // appended after the layer's own positioning transform
  reveal: number; // 0..1 for typewriter-style reveals
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function one(name: Anim["in"], p: number, fps: number, frame: number, entering: boolean) {
  // p: 0 = fully hidden, 1 = fully shown
  const style: CSSProperties = {};
  let transform = "";
  let reveal = 1;
  const springy = entering
    ? spring({ frame, fps, config: { damping: 12, stiffness: 180, mass: 0.6 } })
    : p;
  switch (name) {
    case "none":
      break;
    case "fade":
      style.opacity = p;
      break;
    case "pop":
      style.opacity = clamp01(p * 2);
      transform = `scale(${interpolate(entering ? springy : p, [0, 1], [0.4, 1])})`;
      break;
    case "bounce":
      style.opacity = clamp01(p * 3);
      transform = `translateY(${interpolate(entering ? springy : p, [0, 1], [120, 0])}px)`;
      break;
    case "slideUp":
      style.opacity = p;
      transform = `translateY(${(1 - p) * 140}px)`;
      break;
    case "slideDown":
      style.opacity = p;
      transform = `translateY(${-(1 - p) * 140}px)`;
      break;
    case "slideLeft":
      style.opacity = p;
      transform = `translateX(${(1 - p) * 220}px)`;
      break;
    case "slideRight":
      style.opacity = p;
      transform = `translateX(${-(1 - p) * 220}px)`;
      break;
    case "zoomIn":
      style.opacity = p;
      transform = `scale(${interpolate(p, [0, 1], [1.8, 1])})`;
      break;
    case "zoomOut":
      style.opacity = p;
      transform = `scale(${interpolate(p, [0, 1], [0.2, 1])})`;
      break;
    case "blurIn":
      style.opacity = p;
      style.filter = `blur(${(1 - p) * 24}px)`;
      break;
    case "wipe":
      style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
      break;
    case "spin":
      style.opacity = p;
      transform = `rotate(${(1 - p) * -180}deg) scale(${0.3 + 0.7 * p})`;
      break;
    case "typewriter":
      reveal = p;
      break;
    case "rise":
      // Rises from its baseline while being revealed bottom-up (the "mask reveal" look).
      transform = `translateY(${(1 - p) * 35}%)`;
      style.clipPath = `inset(${((1 - p) * 100).toFixed(1)}% -25% -25% -25%)`;
      break;
    case "elastic": {
      const s = entering ? spring({ frame, fps, config: { damping: 6, stiffness: 160, mass: 0.7 } }) : p;
      style.opacity = clamp01(p * 3);
      transform = `scale(${Math.max(0, s).toFixed(3)})`;
      break;
    }
    case "blurUp":
      style.opacity = p;
      style.filter = `blur(${((1 - p) * 16).toFixed(1)}px)`;
      transform = `translateY(${(1 - p) * 60}px)`;
      break;
    case "glitch": {
      const live = p < 1;
      const r = random(`glitch${frame}${entering ? "i" : "o"}`);
      style.opacity = live ? (r > 0.3 ? p : 0.15) : 1;
      transform = live ? `translateX(${((random(`gx${frame}`) - 0.5) * 50 * (1 - p)).toFixed(1)}px) skewX(${((r - 0.5) * 20 * (1 - p)).toFixed(1)}deg)` : "";
      if (live) style.filter = `hue-rotate(${Math.round((r - 0.5) * 90 * (1 - p))}deg) contrast(${(1 + 0.5 * (1 - p)).toFixed(2)})`;
      break;
    }
    case "stagger":
      // Text layers stagger word by word themselves (they pass in: "none" here); anything else just pops.
      style.opacity = clamp01(p * 2);
      transform = `scale(${interpolate(entering ? springy : p, [0, 1], [0.6, 1])})`;
      break;
    case "scaleBlur":
      style.opacity = p;
      style.filter = `blur(${((1 - p) * 14).toFixed(1)}px)`;
      transform = `scale(${interpolate(p, [0, 1], [1.35, 1])})`;
      break;
  }
  return { style, transform, reveal };
}

/**
 * @param frame frame relative to the layer start
 * @param durationFrames layer length in frames
 */
export function animate(anim: Anim, frame: number, durationFrames: number, fps: number): AnimState {
  const inFrames = Math.max(1, Math.round(anim.duration * fps));
  const outFrames = Math.max(1, Math.round(anim.duration * fps * 0.8));
  const ease = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
  const pIn = anim.in === "none" ? 1 : ease(frame / inFrames);
  const pOut = anim.out === "none" ? 1 : ease((durationFrames - frame) / outFrames);
  const a = one(anim.in, pIn, fps, frame, true);
  const b = one(anim.out, pOut, fps, frame, false);
  const opacity = (a.style.opacity ?? 1) as number;
  const opacityOut = (b.style.opacity ?? 1) as number;
  return {
    style: {
      ...a.style,
      ...b.style,
      opacity: opacity * opacityOut,
      filter: [a.style.filter, b.style.filter].filter(Boolean).join(" ") || undefined,
      clipPath: frame < inFrames ? a.style.clipPath : b.style.clipPath,
    },
    transform: `${a.transform} ${b.transform}`.trim(),
    reveal: Math.min(a.reveal, b.reveal),
  };
}
