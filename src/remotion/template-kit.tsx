// Shared helpers for motion-graphics templates (templates.tsx + templates-social.tsx).
import type React from "react";
import type { CSSProperties } from "react";
import { Img, spring } from "remotion";
import { fontStack } from "../shared/catalog";
import type { Brand, FontName, TemplateOverlay } from "../shared/spec";

export type TemplateCtx = {
  o: TemplateOverlay;
  frame: number;
  dur: number;
  fps: number;
  W: number;
  H: number;
  brand: Brand;
  /** URL of an IMAGE in the project by mediaId (undefined if missing / not an image). */
  img: (mediaId: string | undefined) => string | undefined;
};

export const str = (o: TemplateOverlay, k: string, d = "") => (o.props[k] === undefined || o.props[k] === "" ? d : String(o.props[k]));
export const num = (o: TemplateOverlay, k: string, d: number) => {
  const v = Number(o.props[k]);
  return o.props[k] !== undefined && o.props[k] !== "" && Number.isFinite(v) ? v : d;
};
export const bool = (o: TemplateOverlay, k: string, d = false) =>
  o.props[k] === undefined ? d : o.props[k] === true || o.props[k] === "true";
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const unit = (c: TemplateCtx) => (Math.min(c.W, c.H) / 1080) * c.o.scale;
export const font = (c: TemplateCtx, d: FontName) => fontStack(c.o.font ?? d);
export const sp = (c: TemplateCtx, delay = 0, damping = 12) =>
  spring({ frame: c.frame - delay, fps: c.fps, config: { damping, stiffness: 170, mass: 0.7 } });
export const at = (c: TemplateCtx, dx: number, dy: number): CSSProperties => ({
  position: "absolute",
  left: (c.o.x ?? dx) * c.W,
  top: (c.o.y ?? dy) * c.H,
});
export const shadow = "0 10px 30px rgba(0,0,0,0.35)";
export const easeOut3 = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);

/** 12500 -> "12.5K", 1200000 -> "1.2M". */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Math.round(n).toLocaleString("en-US");
}

/** Brand / prop text with the brand as fallback. */
export const handleOf = (c: TemplateCtx, d = "@yourhandle") => {
  const h = str(c.o, "handle", c.brand.handle ?? d);
  return h.startsWith("@") ? h : `@${h}`;
};
export const nameOf = (c: TemplateCtx, d = "Your Name") => str(c.o, "user", str(c.o, "name", c.brand.name ?? d));

/** Round profile picture: the `avatar` prop / brand avatar image, else an initial on the accent colour. */
export const Avatar: React.FC<{ c: TemplateCtx; size: number; label: string; ring?: string }> = ({ c, size, label, ring }) => {
  const src = c.img(str(c.o, "avatar", c.brand.avatar ?? ""));
  const style: CSSProperties = {
    width: size, height: size, borderRadius: "50%", flex: "none", overflow: "hidden",
    boxShadow: ring ? `0 0 0 ${size * 0.06}px ${ring}` : undefined,
  };
  if (src) return <Img src={src} style={{ ...style, objectFit: "cover" }} />;
  const initial = label.replace(/^[@#]/, "").trim().charAt(0).toUpperCase() || "?";
  return (
    <div style={{ ...style, background: `linear-gradient(135deg, ${c.o.accent}, ${c.brand.colors[1] ?? "#FF5A36"})`, display: "grid", placeItems: "center", color: "#111", fontFamily: fontStack("Montserrat"), fontWeight: 900, fontSize: size * 0.46 }}>
      {initial}
    </div>
  );
};
