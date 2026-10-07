// Maps spec transition names to Remotion presentations (built-in CSS ones + 3 custom).
import type React from "react";
import { AbsoluteFill, random } from "remotion";
import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import { clockWipe } from "@remotion/transitions/clock-wipe";
import { fade } from "@remotion/transitions/fade";
import { flip } from "@remotion/transitions/flip";
import { iris } from "@remotion/transitions/iris";
import { pushCut } from "@remotion/transitions/push-cut";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import type { Clip } from "../shared/spec";

type Empty = Record<string, never>;
type Dir = "left" | "right" | "up" | "down";
type DirProps = { dir: Dir };

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

const ZoomThrough: React.FC<TransitionPresentationComponentProps<Empty>> = ({
  children, presentationDirection, presentationProgress,
}) => {
  const p = easeInOut(presentationProgress);
  const style =
    presentationDirection === "exiting"
      ? { transform: `scale(${1 + p * 0.7})`, opacity: 1 - p, filter: `blur(${p * 10}px)` }
      : { transform: `scale(${1.5 - 0.5 * p})`, opacity: p, filter: `blur(${(1 - p) * 10}px)` };
  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};

const BlurDissolve: React.FC<TransitionPresentationComponentProps<Empty>> = ({
  children, presentationDirection, presentationProgress,
}) => {
  const p = easeInOut(presentationProgress);
  const style =
    presentationDirection === "exiting"
      ? { filter: `blur(${p * 28}px)`, opacity: 1 }
      : { filter: `blur(${(1 - p) * 28}px)`, opacity: p };
  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};

const Whip: React.FC<TransitionPresentationComponentProps<DirProps>> = ({
  children, presentationDirection, presentationProgress, passedProps,
}) => {
  const p = easeInOut(presentationProgress);
  const axis = passedProps.dir === "up" || passedProps.dir === "down" ? "Y" : "X";
  const sign = passedProps.dir === "right" || passedProps.dir === "down" ? 1 : -1;
  const blur = Math.sin(p * Math.PI) * 26;
  const offset = presentationDirection === "exiting" ? sign * p * 100 : -sign * (1 - p) * 100;
  return (
    <AbsoluteFill style={{ transform: `translate${axis}(${offset}%)`, filter: `blur(${blur}px)` }}>
      {children}
    </AbsoluteFill>
  );
};

// ---- creator transitions: most "cut" at the midpoint (old shot until 0.5, new shot after) ----

const easeIn = (k: number) => k * k;
const easeOut = (k: number) => 1 - (1 - k) * (1 - k);
const firstHalf = (p: number) => Math.min(1, p / 0.5);
const secondHalf = (p: number) => Math.max(0, (p - 0.5) / 0.5);

/** Zoom INTO the cut, then settle out of it — with motion blur. */
const ZoomPunch: React.FC<TransitionPresentationComponentProps<Empty>> = ({ children, presentationDirection, presentationProgress: p }) => {
  if (presentationDirection === "exiting") {
    const e = easeIn(firstHalf(p));
    return <AbsoluteFill style={{ transform: `scale(${1 + 0.65 * e})`, filter: `blur(${16 * e}px)`, opacity: p < 0.5 ? 1 : 0 }}>{children}</AbsoluteFill>;
  }
  const e = easeOut(secondHalf(p));
  return <AbsoluteFill style={{ transform: `scale(${1.65 - 0.65 * e})`, filter: `blur(${16 * (1 - e)}px)`, opacity: p >= 0.5 ? 1 : 0 }}>{children}</AbsoluteFill>;
};

const Spin: React.FC<TransitionPresentationComponentProps<Empty>> = ({ children, presentationDirection, presentationProgress: p }) => {
  if (presentationDirection === "exiting") {
    const e = easeIn(firstHalf(p));
    return <AbsoluteFill style={{ transform: `rotate(${150 * e}deg) scale(${1 + 0.45 * e})`, filter: `blur(${18 * e}px)`, opacity: p < 0.5 ? 1 : 0 }}>{children}</AbsoluteFill>;
  }
  const e = easeOut(secondHalf(p));
  return <AbsoluteFill style={{ transform: `rotate(${-150 * (1 - e)}deg) scale(${1.45 - 0.45 * e})`, filter: `blur(${18 * (1 - e)}px)`, opacity: p >= 0.5 ? 1 : 0 }}>{children}</AbsoluteFill>;
};

/** Light flash: the picture blows out to warm white at the cut and comes back. */
const Flash: React.FC<TransitionPresentationComponentProps<Empty>> = ({ children, presentationDirection, presentationProgress: p }) => {
  const exiting = presentationDirection === "exiting";
  const glow = exiting ? easeIn(firstHalf(p)) : 1 - easeOut(secondHalf(p));
  return (
    <AbsoluteFill style={{ opacity: exiting ? (p < 0.5 ? 1 : 0) : p >= 0.5 ? 1 : 0 }}>
      <AbsoluteFill style={{ filter: `brightness(${1 + 2.2 * glow}) saturate(${1 - 0.4 * glow})` }}>{children}</AbsoluteFill>
      <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 45%, #fffaf0 0%, #ffd9a0 55%, #ff9a5a 100%)", opacity: glow * 0.92, mixBlendMode: "screen" }} />
    </AbsoluteFill>
  );
};

/** Digital glitch: jumpy offsets, RGB split, flicker between the two shots. */
const Glitch: React.FC<TransitionPresentationComponentProps<Empty>> = ({ children, presentationDirection, presentationProgress: p }) => {
  const q = Math.min(11, Math.floor(p * 12));
  const exiting = presentationDirection === "exiting";
  // Mostly old shot first, new shot second — with a few frames of flicker either side of the cut.
  const showNew = q >= 6 ? q !== 7 : q === 4;
  const visible = exiting ? !showNew : showNew;
  const intensity = Math.sin(Math.PI * p);
  const dx = (random(`gx${q}`) - 0.5) * 9 * intensity;
  const dy = (random(`gy${q}`) - 0.5) * 2.5 * intensity;
  const id = `glitch-${exiting ? "o" : "i"}`;
  return (
    <AbsoluteFill style={{ opacity: visible ? 1 : 0 }}>
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id={id} colorInterpolationFilters="sRGB">
          <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
          <feOffset in="r" dx={18 * intensity} dy="0" result="r2" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="gb" />
          <feOffset in="gb" dx={-18 * intensity} dy="0" result="gb2" />
          <feBlend in="r2" in2="gb2" mode="screen" />
        </filter>
      </svg>
      <AbsoluteFill style={{ transform: `translate(${dx}%, ${dy}%) scale(${1 + 0.06 * intensity})`, filter: `url(#${id}) contrast(${1 + 0.4 * intensity}) hue-rotate(${(random(`gh${q}`) - 0.5) * 60 * intensity}deg)` }}>
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Both shots push together (like a camera move) with motion blur and a slight zoom-in. */
const SmoothSlide: React.FC<TransitionPresentationComponentProps<DirProps>> = ({ children, presentationDirection, presentationProgress, passedProps }) => {
  const e = easeInOut(presentationProgress);
  const axis = passedProps.dir === "up" || passedProps.dir === "down" ? "Y" : "X";
  const sign = passedProps.dir === "right" || passedProps.dir === "down" ? 1 : -1;
  const wave = Math.sin(Math.PI * presentationProgress);
  const offset = presentationDirection === "exiting" ? sign * e * 100 : -sign * (1 - e) * 100;
  // Scale is applied after the translate, about the canvas centre, so the two shots stay edge to edge.
  return (
    <AbsoluteFill style={{ transform: `scale(${1 + 0.08 * wave}) translate${axis}(${offset}%)`, filter: `blur(${wave * 10}px)` }}>
      {children}
    </AbsoluteFill>
  );
};

/** Horizontal shutter bars close over the old shot, then open on the new one. */
const Shutter: React.FC<TransitionPresentationComponentProps<{ height: number }>> = ({ children, presentationDirection, presentationProgress: p, passedProps }) => {
  const band = passedProps.height / 8;
  const open = presentationDirection === "exiting" ? 1 - easeIn(firstHalf(p)) : easeOut(secondHalf(p));
  const vis = Math.max(0, band * open);
  const mask = `repeating-linear-gradient(to bottom, #000 0px, #000 ${vis.toFixed(1)}px, transparent ${vis.toFixed(1)}px, transparent ${band.toFixed(1)}px)`;
  return <AbsoluteFill style={{ maskImage: mask, WebkitMaskImage: mask }}>{children}</AbsoluteFill>;
};

const slideDir = (d: Dir) =>
  ({ left: "from-right", right: "from-left", up: "from-bottom", down: "from-top" } as const)[d];

export function presentationFor(
  t: NonNullable<Clip["transition"]>,
  width: number,
  height: number,
): TransitionPresentation<Record<string, unknown>> {
  const d = t.direction;
  let p: TransitionPresentation<any>;
  switch (t.type) {
    case "slide": p = slide({ direction: slideDir(d) }); break;
    case "wipe": p = wipe({ direction: slideDir(d) }); break;
    case "flip": p = flip({ direction: slideDir(d) }); break;
    case "clockWipe": p = clockWipe({ width, height }); break;
    case "iris": p = iris({ width, height }); break;
    case "pushCut": p = pushCut({}); break;
    case "zoom": p = { component: ZoomThrough, props: {} }; break;
    case "blur": p = { component: BlurDissolve, props: {} }; break;
    case "whip": p = { component: Whip, props: { dir: d } }; break;
    case "zoomPunch": p = { component: ZoomPunch, props: {} }; break;
    case "spin": p = { component: Spin, props: {} }; break;
    case "flash": p = { component: Flash, props: {} }; break;
    case "glitch": p = { component: Glitch, props: {} }; break;
    case "smoothSlide": p = { component: SmoothSlide, props: { dir: d } }; break;
    case "shutter": p = { component: Shutter, props: { height } }; break;
    case "fade":
    case "cut":
    default: p = fade();
  }
  return p as TransitionPresentation<Record<string, unknown>>;
}
