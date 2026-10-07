// Timed layers above the main video: text, shapes, images, B-roll / PiP, face bubble, templates.
import type React from "react";
import type { CSSProperties } from "react";
import { AbsoluteFill, Img, Sequence, spring, useCurrentFrame } from "remotion";
import { fontStack } from "../shared/catalog";
import type {
  CompositionProps, FaceCamOverlay, ImageOverlay, Overlay, ShapeOverlay, TemplateOverlay, TextOverlay, VideoOverlay,
} from "../shared/spec";
import { type ClipLayout, faceAt, layoutClips, sourceTimeAt } from "../shared/timeline";
import { animate } from "./anim";
import { mediaSrc } from "./MainVideo";
import { TEMPLATE_COMPONENTS } from "./templates";
import { VideoTag } from "./VideoTag";

type LayerProps<T> = { o: T; props: CompositionProps; dur: number };
const RTL = /[֐-ࣿיִ-ﻼ]/;

const TextLayer: React.FC<LayerProps<TextOverlay>> = ({ o, props, dur }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = props.spec.format;
  const stagger = o.anim.in === "stagger";
  const a = animate(stagger ? { ...o.anim, in: "none" } : o.anim, frame, dur, fps);
  const s = o.style;
  const full = s.uppercase ? o.text.toUpperCase() : o.text;
  const text = a.reveal < 1 ? full.slice(0, Math.ceil(full.length * a.reveal)) : full;
  // "stagger": each word springs up in turn (kinetic typography).
  const content = stagger
    ? full.split(/(\s+)/).map((w, i) => {
        if (/^\s+$/.test(w)) return w;
        const k = spring({ frame: frame - (i / 2) * Math.max(1, Math.round(0.07 * fps)), fps, config: { damping: 12, stiffness: 210, mass: 0.5 } });
        return (
          <span key={i} style={{ display: "inline-block", opacity: Math.min(1, k * 2), transform: `translateY(${((1 - k) * 0.5).toFixed(3)}em) scale(${(0.7 + 0.3 * k).toFixed(3)})` }}>
            {w}
          </span>
        );
      })
    : text;
  const rtl = RTL.test(full);
  const inner: CSSProperties = {
    fontFamily: fontStack(s.font),
    fontSize: s.size,
    fontWeight: s.weight,
    fontStyle: s.italic ? "italic" : "normal",
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    color: s.gradient ? "transparent" : s.color,
    background: s.gradient ? `linear-gradient(90deg, ${s.gradient[0]}, ${s.gradient[1]})` : undefined,
    WebkitBackgroundClip: s.gradient ? "text" : undefined,
    backgroundClip: s.gradient ? "text" : undefined,
    WebkitTextStroke: s.strokeWidth ? `${s.strokeWidth}px ${s.strokeColor ?? "#000"}` : undefined,
    paintOrder: "stroke fill",
    textShadow: s.shadow && !s.gradient ? "0 6px 24px rgba(0,0,0,0.45), 0 2px 4px rgba(0,0,0,0.5)" : undefined,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  };
  return (
    <div
      style={{
        position: "absolute",
        left: o.x * W,
        top: o.y * H,
        width: "max-content",
        maxWidth: o.maxWidth * W,
        transform: `translate(-50%,-50%) rotate(${o.rotation}deg) ${a.transform}`,
        textAlign: s.align,
        direction: rtl ? "rtl" : "ltr",
        background: s.background,
        borderRadius: s.radius,
        padding: s.background ? "0.18em 0.5em" : 0,
        boxShadow: s.background && s.shadow ? "0 10px 30px rgba(0,0,0,0.35)" : undefined,
        opacity: o.opacity * (a.style.opacity as number),
        filter: a.style.filter,
        clipPath: a.style.clipPath,
      }}
    >
      <span style={inner}>{content}</span>
    </div>
  );
};

function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`);
  }
  return pts.join(" ");
}

const ShapeLayer: React.FC<LayerProps<ShapeOverlay>> = ({ o, props, dur }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = props.spec.format;
  const a = animate(o.anim, frame, dur, fps);
  const cx = o.x * W, cy = o.y * H, w = o.w * W, h = o.h * H;
  const drawP = o.draw ? Math.min(1, frame / Math.max(1, Math.round(0.5 * fps))) : 1;
  const fill = o.fill ? o.color : "none";
  const stroke = o.fill ? "none" : o.color;
  const sw = o.strokeWidth;
  let el: React.ReactNode = null;
  const dash = (len: number) => ({ strokeDasharray: len, strokeDashoffset: len * (1 - drawP) });
  switch (o.shape) {
    case "rect":
      el = <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={o.radius} fill={fill} stroke={stroke} strokeWidth={sw} />;
      break;
    case "circle":
      el = <circle cx={cx} cy={cy} r={w / 2} fill={fill} stroke={stroke} strokeWidth={sw} />;
      break;
    case "ring": {
      const r = w / 2;
      el = <circle cx={cx} cy={cy} r={r} fill="none" stroke={o.color} strokeWidth={sw} {...dash(2 * Math.PI * r)} transform={`rotate(-90 ${cx} ${cy})`} strokeLinecap="round" />;
      break;
    }
    case "triangle":
      el = <polygon points={`${cx},${cy - h / 2} ${cx + w / 2},${cy + h / 2} ${cx - w / 2},${cy + h / 2}`} fill={fill} stroke={stroke} strokeWidth={sw} />;
      break;
    case "star":
      el = <polygon points={starPoints(cx, cy, w / 2)} fill={fill} stroke={stroke} strokeWidth={sw} />;
      break;
    case "highlight":
      el = (
        <rect x={cx - w / 2} y={cy - h / 2} width={w * drawP} height={h} rx={h * 0.2} fill={o.color} opacity={0.5}
          style={{ mixBlendMode: "multiply" }} transform={`skewX(-8)`} />
      );
      break;
    case "underline": {
      const x0 = cx - w / 2, x1 = cx + w / 2;
      const d = `M${x0},${cy} C${x0 + w * 0.3},${cy + h * 0.25} ${x0 + w * 0.65},${cy - h * 0.2} ${x1},${cy + h * 0.1}`;
      el = <path d={d} fill="none" stroke={o.color} strokeWidth={sw} strokeLinecap="round" {...dash(w * 1.1)} />;
      break;
    }
    case "line":
    case "arrow": {
      const x2 = (o.x2 ?? o.x + 0.2) * W, y2 = (o.y2 ?? o.y) * H;
      const len = Math.hypot(x2 - cx, y2 - cy);
      const ang = Math.atan2(y2 - cy, x2 - cx);
      const hl = Math.max(18, sw * 3.2);
      el = (
        <>
          <line x1={cx} y1={cy} x2={x2} y2={y2} stroke={o.color} strokeWidth={sw} strokeLinecap="round" {...dash(len)} />
          {o.shape === "arrow" && drawP >= 1 ? (
            <path
              d={`M${x2},${y2} L${x2 - hl * Math.cos(ang - 0.5)},${y2 - hl * Math.sin(ang - 0.5)} M${x2},${y2} L${x2 - hl * Math.cos(ang + 0.5)},${y2 - hl * Math.sin(ang + 0.5)}`}
              stroke={o.color} strokeWidth={sw} strokeLinecap="round" fill="none"
            />
          ) : null}
        </>
      );
      break;
    }
  }
  return (
    <AbsoluteFill
      style={{
        transformOrigin: `${cx}px ${cy}px`,
        transform: `rotate(${o.rotation}deg) ${a.transform}`,
        opacity: o.opacity * (a.style.opacity as number),
        filter: a.style.filter,
        clipPath: a.style.clipPath,
      }}
    >
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, overflow: "visible", filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.3))" }}>
        {el}
      </svg>
    </AbsoluteFill>
  );
};

const boxStyle = (
  o: { x: number; y: number; w: number; shape: "rect" | "circle"; radius: number; border?: string | undefined; opacity: number },
  W: number, H: number, aspect: number, a: ReturnType<typeof animate>,
): CSSProperties => {
  const bw = o.w * W;
  const bh = o.shape === "circle" ? bw : bw / aspect;
  return {
    position: "absolute",
    left: o.x * W - bw / 2,
    top: o.y * H - bh / 2,
    width: bw,
    height: bh,
    borderRadius: o.shape === "circle" ? "50%" : o.radius,
    overflow: "hidden",
    border: o.border ? `${Math.max(4, bw * 0.012)}px solid ${o.border}` : undefined,
    boxShadow: "0 18px 40px rgba(0,0,0,0.4)",
    transform: a.transform,
    opacity: o.opacity * (a.style.opacity as number),
    filter: a.style.filter,
    clipPath: a.style.clipPath,
  };
};

const ImageLayer: React.FC<LayerProps<ImageOverlay>> = ({ o, props, dur }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = props.spec.format;
  const m = props.media[o.mediaId];
  if (!m) return null;
  const a = animate(o.anim, frame, dur, fps);
  const zoom = o.kenBurns ? 1 + 0.12 * (frame / Math.max(1, dur)) : 1;
  const style = boxStyle(o, W, H, (m.width || 1) / (m.height || 1), a);
  if (!o.shadow) style.boxShadow = undefined;
  return (
    <div style={style}>
      <Img src={m.src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${zoom})` }} />
    </div>
  );
};

const VideoLayer: React.FC<LayerProps<VideoOverlay>> = ({ o, props, dur }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = props.spec.format;
  const m = props.media[o.mediaId];
  if (!m) return null;
  const a = animate(o.anim, frame, dur, fps);
  const video = (
    <VideoTag
      src={mediaSrc(m, props.preview)}
      trimBefore={Math.round(o.in * fps)}
      playbackRate={o.speed}
      muted={o.muted}
      volume={o.muted ? 0 : o.volume}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
  if (o.fullscreen) {
    return (
      <AbsoluteFill style={{ opacity: o.opacity * (a.style.opacity as number), transform: a.transform, filter: a.style.filter, clipPath: a.style.clipPath }}>
        {video}
      </AbsoluteFill>
    );
  }
  return <div style={boxStyle(o, W, H, (m.width || 16) / (m.height || 9), a)}>{video}</div>;
};

/** Circular bubble showing the speaker's face from whatever main clip is playing. */
const FaceCamLayer: React.FC<LayerProps<FaceCamOverlay> & { startFrame: number; layouts: ClipLayout[] }> = ({
  o, props, dur, startFrame, layouts,
}) => {
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = props.spec.format;
  const a = animate(o.anim, frame, dur, fps);
  const size = o.size * W;
  const t = (startFrame + frame) / fps;
  const segs = layouts.filter((l) => l.start < o.end && l.end > o.start);
  return (
    <div
      style={{
        position: "absolute", left: o.x * W - size / 2, top: o.y * H - size / 2, width: size, height: size,
        borderRadius: "50%", overflow: "hidden", border: `${Math.max(4, size * 0.03)}px solid ${o.border}`,
        boxShadow: "0 18px 40px rgba(0,0,0,0.45)", background: "#111",
        transform: a.transform, opacity: o.opacity * (a.style.opacity as number), filter: a.style.filter,
      }}
    >
      {segs.map((l) => {
        const m = props.media[l.clip.mediaId];
        if (!m || m.kind !== "video") return null;
        const segStart = Math.max(o.start, l.start);
        const segEnd = Math.min(o.end, l.end);
        const from = Math.round(segStart * fps) - startFrame;
        const face = faceAt(props.analysis[m.id]?.faces, sourceTimeAt(l, Math.min(Math.max(t, segStart), segEnd - 1 / fps)));
        const k = o.zoom / 1.6;
        const dispW = face ? (size / (face.w * 1.8)) * k : Math.max(size / m.width, size / m.height) * m.width * k;
        const dispH = dispW * (m.height / m.width);
        const left = face ? size / 2 - face.cx * dispW : (size - dispW) / 2;
        const top = face ? size / 2 - face.cy * dispH : (size - dispH) / 2;
        return (
          <Sequence key={l.clip.id + l.index} from={from} durationInFrames={Math.max(1, Math.round((segEnd - segStart) * fps))} layout="none">
            <VideoTag
              src={mediaSrc(m, props.preview)}
              trimBefore={Math.round(sourceTimeAt(l, segStart) * fps)}
              playbackRate={l.clip.speed}
              muted
              style={{ position: "absolute", left, top, width: dispW, height: dispH, maxWidth: "none" }}
            />
          </Sequence>
        );
      })}
    </div>
  );
};

const TemplateLayer: React.FC<LayerProps<TemplateOverlay>> = ({ o, props, dur }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = props.spec.format;
  const Comp = TEMPLATE_COMPONENTS[o.template];
  // Templates animate their own entrance; only the exit comes from `anim.out`.
  const a = animate({ ...o.anim, in: "none" }, frame, dur, fps);
  return (
    <AbsoluteFill style={{ opacity: o.opacity * (a.style.opacity as number), transform: a.transform || undefined, filter: a.style.filter, clipPath: a.style.clipPath }}>
      <Comp o={o} frame={frame} dur={dur} fps={fps} W={W} H={H} brand={props.spec.brand} img={(id) => imageSrc(props, id)} />
    </AbsoluteFill>
  );
};

/** URL of an image in the project (templates use it for avatars / versus pictures). */
function imageSrc(props: CompositionProps, id: string | undefined): string | undefined {
  const m = id ? props.media[id] : undefined;
  return m && m.kind === "image" ? mediaSrc(m, props.preview) : undefined;
}

export const OverlayStack: React.FC<{ props: CompositionProps; overlays: Overlay[] }> = ({ props, overlays }) => {
  const fps = props.spec.format.fps;
  const layouts = layoutClips(props.spec);
  const sorted = [...overlays].sort((a, b) => a.z - b.z);
  return (
    <>
      {sorted.map((o) => {
        const from = Math.round(o.start * fps);
        const dur = Math.max(1, Math.round((o.end - o.start) * fps));
        if (o.end <= o.start) return null;
        let el: React.ReactNode;
        switch (o.type) {
          case "text": el = <TextLayer o={o} props={props} dur={dur} />; break;
          case "shape": el = <ShapeLayer o={o} props={props} dur={dur} />; break;
          case "image": el = <ImageLayer o={o} props={props} dur={dur} />; break;
          case "video": el = <VideoLayer o={o} props={props} dur={dur} />; break;
          case "faceCam": el = <FaceCamLayer o={o} props={props} dur={dur} startFrame={from} layouts={layouts} />; break;
          case "template": el = <TemplateLayer o={o} props={props} dur={dur} />; break;
        }
        return (
          <Sequence key={o.id} from={from} durationInFrames={dur} premountFor={o.type === "video" || o.type === "faceCam" ? fps : 0}>
            {el}
          </Sequence>
        );
      })}
    </>
  );
};
