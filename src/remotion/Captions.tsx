// Word-synced captions generated from the local whisper transcript.
import type React from "react";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { AbsoluteFill, spring, useCurrentFrame } from "remotion";
import { fontStack } from "../shared/catalog";
import type { Captions as CaptionSettings, CompositionProps } from "../shared/spec";
import { type OutputWord, mapWords, paginateWords } from "../shared/timeline";

const RTL = /[֐-ࣿיִ-ﻼ]/;
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

function emphasisFor(c: CaptionSettings, w: OutputWord) {
  return c.emphasis.find(
    (e) => (e.word && norm(e.word) === norm(w.text)) || (e.at !== undefined && e.at >= w.start - 0.05 && e.at < w.end + 0.05),
  );
}

export const Captions: React.FC<{ props: CompositionProps }> = ({ props }) => {
  const frame = useCurrentFrame();
  const { spec, analysis } = props;
  const c = spec.captions;
  const { width: W, height: H, fps } = spec.format;
  const pages = useMemo(() => {
    if (!c.enabled) return [];
    const silent = new Set(spec.audio.voice.filter((v) => !v.captions).map((v) => `voice:${v.id}`));
    return paginateWords(mapWords(spec, analysis).filter((w) => !silent.has(w.clipId)), c.maxWordsPerPage);
  }, [spec, analysis, c.enabled, c.maxWordsPerPage]);
  if (!c.enabled) return null;
  const t = frame / fps;
  if (c.hide.some((h) => t >= h.start && t < h.end)) return null;
  const page = pages.find((p) => t >= p.start && t < p.end);
  if (!page) return null;

  let active = -1;
  page.words.forEach((w, i) => {
    if (t >= w.start) active = i;
  });
  const pageFrame = frame - Math.round(page.start * fps);
  const pageIn = spring({ frame: pageFrame, fps, config: { damping: 14, stiffness: 220, mass: 0.6 } });
  const minimal = c.style === "minimal";
  const upper = c.uppercase && !minimal;
  const size = minimal ? c.size * 0.62 : c.size;
  const rtl = page.words.some((w) => RTL.test(w.text));
  const emojiWord = active >= 0 ? emphasisFor(c, page.words[active]!) : undefined;

  const base: CSSProperties = {
    fontFamily: fontStack(c.font),
    fontSize: size,
    fontWeight: minimal ? 600 : 900,
    color: c.color,
    lineHeight: 1.12,
    WebkitTextStroke: !minimal && c.strokeWidth > 0 && c.style !== "boxed" && c.style !== "neon" ? `${c.strokeWidth}px ${c.strokeColor}` : undefined,
    paintOrder: "stroke fill",
    textShadow: minimal ? "0 2px 10px rgba(0,0,0,0.85)" : "0 6px 18px rgba(0,0,0,0.45)",
    display: "inline-block",
    // Wide enough that a scaled-up active word never collides with its neighbours.
    margin: `0 ${size * 0.2}px`,
    transformOrigin: "50% 60%",
  };

  const words = page.words.map((w, i) => {
    const e = emphasisFor(c, w);
    const isActive = i === active;
    const spoken = i <= active;
    const wordFrame = frame - Math.round(w.start * fps);
    const pop = spring({ frame: wordFrame, fps, config: { damping: 11, stiffness: 260, mass: 0.5 } });
    const text = upper ? w.text.toUpperCase() : w.text;
    const style: CSSProperties = { ...base };
    let content: React.ReactNode = text;
    const emphColor = e?.color;
    switch (c.style) {
      case "bold":
        style.color = isActive ? emphColor ?? c.highlightColor : emphColor ?? c.color;
        style.transform = `scale(${isActive ? 1 + (0.08 * pop * (e?.scale ?? 1.25)) / 1.25 : 1})`;
        break;
      case "karaoke":
        style.color = isActive ? emphColor ?? c.highlightColor : c.color;
        style.opacity = spoken ? 1 : 0.55;
        break;
      case "pop":
        if (!spoken) style.opacity = 0;
        style.transform = `scale(${spoken ? 0.5 + 0.5 * pop : 0.5})`;
        style.color = isActive ? emphColor ?? c.highlightColor : emphColor ?? c.color;
        break;
      case "boxed":
        if (isActive) {
          style.background = emphColor ?? c.highlightColor;
          style.color = "#111";
          style.borderRadius = size * 0.18;
          style.padding = `0 ${size * 0.14}px`;
          style.textShadow = "none";
        }
        break;
      case "highlight":
        if (isActive) {
          style.background = emphColor ?? c.highlightColor;
          style.color = "#111";
          style.WebkitTextStroke = undefined;
          style.borderRadius = size * 0.2;
          style.padding = `0 ${size * 0.16}px`;
          style.transform = `rotate(-2deg) scale(${1 + 0.06 * pop})`;
          style.textShadow = "none";
        }
        break;
      case "neon": {
        const glow = isActive ? emphColor ?? c.highlightColor : c.color;
        style.color = "#fff";
        style.textShadow = `0 0 ${size * 0.12}px ${glow}, 0 0 ${size * 0.3}px ${glow}, 0 0 ${size * 0.6}px ${glow}`;
        style.opacity = isActive ? 1 : 0.8;
        break;
      }
      case "typewriter": {
        const dur = Math.max(0.05, w.end - w.start);
        const chars = !spoken ? 0 : isActive ? Math.ceil(text.length * Math.min(1, (t - w.start) / dur)) : text.length;
        content = text.slice(0, chars);
        style.color = isActive ? emphColor ?? c.highlightColor : emphColor ?? c.color;
        break;
      }
      case "minimal":
        break;
      case "single": {
        // One big word at a time: only the spoken word is on screen, popping with a tiny alternating tilt.
        if (!isActive) return null;
        style.fontSize = size * 1.3;
        style.color = emphColor ?? (i % 2 ? c.highlightColor : c.color);
        style.transform = `scale(${(0.55 + 0.45 * pop).toFixed(3)}) rotate(${i % 2 ? 2.5 : -2.5}deg)`;
        break;
      }
      case "hormozi": {
        const palette = [c.highlightColor, "#4CFF5A", "#FF4D4D"];
        if (isActive) {
          style.color = emphColor ?? palette[Math.round(w.start * 10) % palette.length]!;
          style.transform = `translateY(${(-0.06 * size * pop).toFixed(1)}px) scale(${(1 + 0.16 * pop).toFixed(3)})`;
        }
        break;
      }
      case "gradient":
        if (isActive) {
          style.color = "transparent";
          style.background = `linear-gradient(95deg, ${emphColor ?? c.highlightColor}, #ff4fd8)`;
          style.WebkitBackgroundClip = "text";
          style.backgroundClip = "text";
          style.WebkitTextStroke = undefined;
          style.textShadow = "none";
          style.filter = `drop-shadow(0 0 ${(size * 0.14).toFixed(1)}px rgba(255,79,216,0.55))`;
          style.transform = `scale(${(1 + 0.06 * pop).toFixed(3)})`;
        }
        break;
      case "outline": {
        const sw = Math.max(2, size * 0.04);
        style.color = isActive ? emphColor ?? c.highlightColor : "transparent";
        style.WebkitTextStroke = `${sw}px ${isActive ? emphColor ?? c.highlightColor : c.color}`;
        style.textShadow = isActive ? `0 0 ${(size * 0.2).toFixed(1)}px rgba(0,0,0,0.35)` : "none";
        break;
      }
    }
    return (
      <span key={`${w.start}-${i}`} style={style}>
        {content}
      </span>
    );
  });

  const boxedBg = c.style === "boxed" || (minimal && c.background);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {emojiWord?.emoji ? (
        <div style={{ position: "absolute", left: W / 2, top: c.y * H - size * 1.5, transform: `translate(-50%,-50%) scale(${spring({ frame: frame - Math.round(page.words[active]!.start * fps), fps, config: { damping: 8 } })})`, fontSize: size * 1.4, fontFamily: fontStack("Inter") }}>
          {emojiWord.emoji}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: W / 2,
          top: c.y * H,
          width: W * 0.88,
          transform: `translate(-50%,-50%) scale(${minimal ? 1 : 0.85 + 0.15 * pageIn})`,
          textAlign: "center",
          direction: rtl ? "rtl" : "ltr",
        }}
      >
        <div
          style={{
            display: "inline-block",
            background: boxedBg ? c.background ?? "rgba(0,0,0,0.72)" : undefined,
            borderRadius: boxedBg ? size * 0.25 : undefined,
            padding: boxedBg ? `${size * 0.12}px ${size * 0.25}px` : undefined,
          }}
        >
          {words}
        </div>
      </div>
    </AbsoluteFill>
  );
};
