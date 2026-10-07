// The main (A-roll) track: clips back-to-back with transitions, reframing, retouch and voice audio.
import type React from "react";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { AbsoluteFill, Audio, Img, useCurrentFrame } from "remotion";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import type { CompositionProps, MediaInfo } from "../shared/spec";
import {
  type ClipLayout, cameraAt, clipAt, faceAt, layoutClips, placeSource, resolveReframe,
  smoothFaceCenter, sourceTimeAt,
} from "../shared/timeline";
import { presentationFor } from "./transitions";
import { VideoTag } from "./VideoTag";

export function mediaSrc(m: MediaInfo, preview: boolean): string {
  return preview && m.previewSrc ? m.previewSrc : m.src;
}

/** Where the speaker's face is on the canvas at output time t (px), or null. */
export function faceOnCanvas(props: CompositionProps, layouts: ClipLayout[], t: number) {
  const l = clipAt(layouts, t);
  if (!l) return null;
  const m = props.media[l.clip.mediaId];
  if (!m) return null;
  const s = sourceTimeAt(l, t);
  const track = props.analysis[m.id]?.faces;
  const f = faceAt(track, s);
  if (!f) return null;
  const { width, height } = props.spec.format;
  const place = placeSource(m, { width, height }, resolveReframe(props.spec, l.clip), smoothFaceCenter(track, s));
  const cx = l.clip.flipX ? 1 - f.cx : f.cx;
  return {
    x: place.left + cx * place.width,
    y: place.top + f.cy * place.height,
    w: f.w * place.width,
    h: f.h * place.height,
  };
}

const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${cx - rx},${cy} a${rx},${ry} 0 1,0 ${2 * rx},0 a${rx},${ry} 0 1,0 ${-2 * rx},0 Z`;

type PxFace = { cx: number; cy: number; w: number; h: number; eyes: number[][]; mouth: number[][] };

/** Soft face mask (pixel coords of a w x h box) with eyes/brows and mouth cut out so they stay sharp. */
function faceMask(face: PxFace, w: number, h: number): string {
  const fw = face.w, fh = face.h;
  const parts = [ellipse(face.cx, face.cy - fh * 0.03, fw * 0.56, fh * 0.66)];
  for (const [ex, ey] of face.eyes) parts.push(ellipse(ex!, ey! - fh * 0.05, fw * 0.17, fh * 0.15));
  const [m1, m2] = face.mouth;
  if (m1 && m2) {
    const mx = (m1[0]! + m2[0]!) / 2, my = (m1[1]! + m2[1]!) / 2;
    const half = Math.hypot(m1[0]! - m2[0]!, m1[1]! - m2[1]!) / 2;
    parts.push(ellipse(mx, my, Math.max(half * 1.3, fw * 0.14), fh * 0.1));
  }
  const blur = Math.max(2, fw * 0.05);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>` +
    `<filter id='b' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='${blur.toFixed(1)}'/></filter>` +
    `<path fill='white' fill-rule='evenodd' filter='url(#b)' d='${parts.join(" ")}'/></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

const Missing: React.FC<{ text: string }> = ({ text }) => (
  <AbsoluteFill style={{ background: "#300", color: "#fff", justifyContent: "center", alignItems: "center", fontSize: 40, fontFamily: "sans-serif" }}>
    {text}
  </AbsoluteFill>
);

const ClipView: React.FC<{ layout: ClipLayout; props: CompositionProps }> = ({ layout, props }) => {
  const frame = useCurrentFrame();
  const { spec, media, analysis, preview } = props;
  const fps = spec.format.fps;
  const clip = layout.clip;
  const m = media[clip.mediaId];
  if (!m) return <Missing text={`Missing media ${clip.mediaId}`} />;

  const srcTime = clip.in + (frame / fps) * clip.speed;
  const track = analysis[m.id]?.faces;
  const place = placeSource(m, spec.format, resolveReframe(spec, clip), smoothFaceCenter(track, srcTime));
  const src = mediaSrc(m, preview);
  const trimBefore = Math.round(clip.in * fps);
  const trimAfter = Math.max(trimBefore + 1, Math.ceil(clip.out * fps));
  const voiceVol = clip.muted ? 0 : clip.volume * spec.audio.voiceVolume;
  const useEnhanced = spec.audio.enhanceVoice && !!m.enhancedSrc;

  const box: CSSProperties = {
    position: "absolute",
    left: place.left,
    top: place.top,
    width: place.width,
    height: place.height,
    maxWidth: "none",
    transform: clip.flipX ? "scaleX(-1)" : undefined,
  };

  const visual = (extra: CSSProperties, muted: boolean, key: string) =>
    m.kind === "image" ? (
      <Img key={key} src={src} style={{ ...box, objectFit: "fill", ...extra }} />
    ) : (
      <VideoTag
        key={key}
        src={src}
        trimBefore={trimBefore}
        trimAfter={trimAfter}
        playbackRate={clip.speed}
        muted={muted}
        volume={muted ? 0 : voiceVol}
        style={{ ...box, objectFit: "fill", ...extra }}
      />
    );

  const layers: React.ReactNode[] = [];
  if (m.kind === "audio") {
    return <Audio src={src} trimBefore={trimBefore} trimAfter={trimAfter} playbackRate={clip.speed} volume={voiceVol} />;
  }
  if (place.mode === "blur") {
    // Blurred fill behind a fitted video. Blur a 1/8-size copy and scale it up: same look,
    // ~64x fewer pixels to blur (full-size CSS blur is the slowest thing Chrome can do on a CPU).
    const DS = 8;
    const s = Math.max(spec.format.width / m.width, spec.format.height / m.height) * 1.08;
    const bw = m.width * s, bh = m.height * s;
    layers.push(
      visual(
        {
          left: (spec.format.width - bw) / 2, top: (spec.format.height - bh) / 2, width: bw / DS, height: bh / DS,
          transform: `scale(${DS})`, transformOrigin: "0 0",
          filter: "blur(5px) brightness(0.55) saturate(1.2)",
        },
        true,
        "bg",
      ),
    );
  }
  layers.push(visual({}, useEnhanced || voiceVol === 0, "main"));

  // Skin smoothing: blurred copies of ONLY the face region, masked with eyes/mouth cut out.
  const smooth = spec.retouch.skinSmooth;
  const face = smooth > 0 ? faceAt(track, srcTime) : null;
  if (face && m.kind === "video") {
    const mx = (x: number) => (clip.flipX ? 1 - x : x);
    const fx = mx(face.cx) * place.width, fy = face.cy * place.height;
    const fw = face.w * place.width, fh = face.h * place.height;
    const rw = fw * 1.6, rh = fh * 1.9;
    const rx = fx - rw / 2, ry = fy - rh * 0.52; // region inside the displayed video
    const local: PxFace = {
      cx: fx - rx, cy: fy - ry, w: fw, h: fh,
      eyes: face.eyes.map(([x, y]) => [mx(x) * place.width - rx, y * place.height - ry]),
      mouth: face.mouth.map(([x, y]) => [mx(x) * place.width - rx, y * place.height - ry]),
    };
    const mask = faceMask(local, rw, rh);
    const r = Math.min(14, Math.max(2, fw * 0.018));
    const region: CSSProperties = {
      position: "absolute", left: place.left + rx, top: place.top + ry, width: rw, height: rh, overflow: "hidden",
      maskImage: mask, WebkitMaskImage: mask, maskSize: "100% 100%", WebkitMaskSize: "100% 100%",
    };
    layers.push(
      <div key="smooth1" style={{ ...region, filter: `blur(${r}px) brightness(1.03)`, mixBlendMode: "lighten", opacity: 0.9 * smooth }}>
        {visual({ left: -rx, top: -ry }, true, "s1")}
      </div>,
      <div key="smooth2" style={{ ...region, filter: `blur(${r * 0.7}px)`, opacity: 0.5 * smooth }}>
        {visual({ left: -rx, top: -ry }, true, "s2")}
      </div>,
    );
  }

  // Camera move over the clip (push / pull / pan / punch), aimed at the face when there is one.
  const f = clip.motion && clip.motion.type !== "none" ? smoothFaceCenter(track, srcTime) : null;
  const focus = f ? { x: place.left + (clip.flipX ? 1 - f.x : f.x) * place.width, y: place.top + f.y * place.height } : null;
  const cam = cameraAt(clip.motion, m.kind, frame / Math.max(1, layout.durationFrames - 1), spec.format, focus);
  return (
    <AbsoluteFill style={{ background: spec.background, overflow: "hidden" }}>
      {cam ? (
        <AbsoluteFill style={{ transform: `translate(${cam.tx.toFixed(1)}px, ${cam.ty.toFixed(1)}px) scale(${cam.scale.toFixed(4)})`, transformOrigin: `${cam.originX.toFixed(0)}px ${cam.originY.toFixed(0)}px` }}>
          {layers}
        </AbsoluteFill>
      ) : layers}
      {useEnhanced && voiceVol > 0 ? (
        <Audio src={m.enhancedSrc!} trimBefore={trimBefore} trimAfter={trimAfter} playbackRate={clip.speed} volume={voiceVol} />
      ) : null}
    </AbsoluteFill>
  );
};

export const MainVideo: React.FC<{ props: CompositionProps }> = ({ props }) => {
  const layouts = useMemo(() => layoutClips(props.spec), [props.spec]);
  if (!layouts.length) return null;
  const { width, height, fps } = props.spec.format;
  const items: React.ReactNode[] = [];
  for (const l of layouts) {
    if (l.transitionFrames > 0 && l.clip.transition) {
      items.push(
        <TransitionSeries.Transition
          key={`t-${l.clip.id}-${l.index}`}
          presentation={presentationFor(l.clip.transition, width, height)}
          timing={linearTiming({ durationInFrames: l.transitionFrames })}
        />,
      );
    }
    items.push(
      <TransitionSeries.Sequence key={`c-${l.clip.id}-${l.index}`} durationInFrames={l.durationFrames} premountFor={fps}>
        <ClipView layout={l} props={props} />
      </TransitionSeries.Sequence>,
    );
  }
  return <TransitionSeries>{items}</TransitionSeries>;
};
