// Motion-graphics templates. Original designs; no third-party logos or assets.
// Each template animates its own entrance; the layer's `anim.out` still controls the exit.
import type React from "react";
import { interpolate, random, spring } from "remotion";
import { fontStack } from "../shared/catalog";
import type { TemplateOverlay } from "../shared/spec";
import { Avatar, at, bool, clamp01, font, handleOf, nameOf, num, shadow, sp, str, type TemplateCtx, unit } from "./template-kit";
import { SOCIAL_TEMPLATES } from "./templates-social";

export type { TemplateCtx } from "./template-kit";

const TitleCard: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const style = str(c.o, "style", "bold");
  const words = str(c.o, "title", "TITLE").split(/\s+/);
  const sub = str(c.o, "subtitle");
  const bar = interpolate(c.frame, [6, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const glitch = style === "glitch" ? (random(`g${Math.floor(c.frame / 2)}`) - 0.5) * 10 * u : 0;
  return (
    <>
      {bool(c.o, "backdrop") ? (
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0.85))", opacity: clamp01(c.frame / 8) }} />
      ) : null}
      <div style={{ ...at(c, 0.5, 0.42), transform: "translate(-50%,-50%)", textAlign: "center", width: c.W * 0.9 }}>
        <div
          style={{
            fontFamily: font(c, style === "minimal" ? "Inter" : "Anton"),
            fontSize: (style === "minimal" ? 96 : 140) * u,
            fontWeight: style === "minimal" ? 300 : 900,
            color: "#fff",
            lineHeight: 1.02,
            letterSpacing: style === "minimal" ? interpolate(c.frame, [0, 30], [24, 6], { extrapolateRight: "clamp" }) * u : 0,
            textTransform: style === "minimal" ? "none" : "uppercase",
            textShadow: style === "glitch"
              ? `${glitch}px 0 #ff2d55, ${-glitch}px 0 #19e6ff, 0 8px 30px rgba(0,0,0,0.5)`
              : "0 8px 30px rgba(0,0,0,0.5)",
          }}
        >
          {words.map((w, i) => {
            const s = sp(c, i * 3);
            return (
              <span key={i} style={{ display: "inline-block", transform: `translateY(${(1 - s) * 60 * u}px) scale(${0.8 + 0.2 * s})`, opacity: clamp01(s * 1.5), margin: `0 ${0.12}em` }}>
                {w}
              </span>
            );
          })}
        </div>
        {style !== "minimal" ? (
          <div style={{ height: 12 * u, width: `${bar * 40}%`, background: c.o.accent, margin: `${18 * u}px auto 0`, borderRadius: 6 * u }} />
        ) : null}
        {sub ? (
          <div style={{ fontFamily: font(c, "Inter"), fontSize: 44 * u, fontWeight: 600, color: "#fff", marginTop: 22 * u, opacity: clamp01((c.frame - 10) / 10), transform: `translateY(${(1 - clamp01((c.frame - 10) / 10)) * 20 * u}px)`, textShadow: shadow }}>
            {sub}
          </div>
        ) : null}
      </div>
    </>
  );
};

const LowerThird: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const right = str(c.o, "side", "left") === "right";
  const barW = interpolate(c.frame, [0, 10], [0, 12 * u], { extrapolateRight: "clamp" });
  const panel = interpolate(c.frame, [4, 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (x) => 1 - Math.pow(1 - x, 3) });
  const title = str(c.o, "title");
  return (
    <div style={{ ...at(c, right ? 0.94 : 0.06, 0.8), transform: right ? "translateX(-100%)" : undefined, display: "flex", flexDirection: right ? "row-reverse" : "row", alignItems: "stretch", gap: 14 * u }}>
      <div style={{ width: barW, background: c.o.accent, borderRadius: 4 * u }} />
      <div style={{ clipPath: right ? `inset(0 0 0 ${(1 - panel) * 100}%)` : `inset(0 ${(1 - panel) * 100}% 0 0)` }}>
        <div style={{ background: "rgba(10,10,14,0.88)", color: "#fff", fontFamily: font(c, "Montserrat"), fontWeight: 800, fontSize: 52 * u, padding: `${12 * u}px ${26 * u}px`, borderRadius: 10 * u, boxShadow: shadow, whiteSpace: "nowrap" }}>
          {nameOf(c, "Name")}
        </div>
        {title ? (
          <div style={{ display: "inline-block", marginTop: 8 * u, background: c.o.accent, color: "#111", fontFamily: font(c, "Montserrat"), fontWeight: 700, fontSize: 32 * u, padding: `${6 * u}px ${18 * u}px`, borderRadius: 8 * u, opacity: clamp01((c.frame - 12) / 8), whiteSpace: "nowrap" }}>
            {title}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const Subscribe: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const appear = sp(c, 0, 11);
  const clickF = Math.round(0.85 * c.fps);
  const clicked = c.frame >= clickF;
  const squish = clicked ? 1 - 0.12 * Math.max(0, 1 - (c.frame - clickF) / 5) : 1;
  const cursorP = clamp01(interpolate(c.frame, [0.2 * c.fps, clickF], [0, 1]));
  const ease = 1 - Math.pow(1 - cursorP, 3);
  const bellShake = c.frame > clickF + 6 ? Math.sin((c.frame - clickF) * 1.6) * 18 * Math.max(0, 1 - (c.frame - clickF - 6) / 20) : 0;
  const btnColor = clicked ? "#3a3a3f" : str(c.o, "color", "#FF0033");
  const channel = str(c.o, "channel", c.brand.handle ?? "");
  return (
    <div style={{ ...at(c, 0.5, 0.8), transform: `translate(-50%,-50%) scale(${appear * squish})`, display: "flex", alignItems: "center", gap: 18 * u }}>
      {channel ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12 * u, background: "rgba(255,255,255,0.95)", borderRadius: 999, padding: `${8 * u}px ${20 * u}px ${8 * u}px ${8 * u}px`, boxShadow: shadow }}>
          <Avatar c={c} size={56 * u} label={channel} />
          <span style={{ fontFamily: font(c, "Montserrat"), fontWeight: 800, fontSize: 32 * u, color: "#111" }}>{channel}</span>
        </div>
      ) : null}
      <div style={{ position: "relative", background: btnColor, color: "#fff", fontFamily: font(c, "Montserrat"), fontWeight: 900, fontSize: 40 * u, padding: `${18 * u}px ${38 * u}px`, borderRadius: 14 * u, boxShadow: shadow, letterSpacing: 1, whiteSpace: "nowrap" }}>
        {clicked ? "✓ " + str(c.o, "doneLabel", "SUBSCRIBED") : str(c.o, "label", "SUBSCRIBE")}
      </div>
      <svg width={64 * u} height={64 * u} viewBox="0 0 24 24" style={{ transform: `rotate(${bellShake}deg)`, transformOrigin: "50% 10%", filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.4))" }}>
        <path fill="#fff" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2z" />
      </svg>
      <svg width={70 * u} height={70 * u} viewBox="0 0 24 24" style={{ position: "absolute", left: `${interpolate(ease, [0, 1], [130, 62])}%`, top: `${interpolate(ease, [0, 1], [190, 48])}%`, opacity: c.frame < clickF + 18 ? 1 : 0, filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.5))", transform: `scale(${clicked && c.frame < clickF + 4 ? 0.85 : 1})` }}>
        <path fill="#fff" stroke="#111" strokeWidth="1.2" d="M5 2l14 10.5-6.2 1.1 3.6 7.3-2.6 1.3-3.6-7.4L5 19.5z" />
      </svg>
    </div>
  );
};

const ProgressBar: React.FC<TemplateCtx> = (c) => {
  const th = num(c.o, "thickness", 10) * c.o.scale;
  const p = clamp01(c.frame / Math.max(1, c.dur - 1));
  const top = str(c.o, "position", "bottom") === "top";
  return (
    <div style={{ position: "absolute", left: 0, right: 0, [top ? "top" : "bottom"]: 0, height: th, background: "rgba(255,255,255,0.18)" }}>
      <div style={{ width: `${p * 100}%`, height: "100%", background: c.o.accent, boxShadow: `0 0 ${th * 1.5}px ${c.o.accent}` }} />
    </div>
  );
};

const EmojiPop: React.FC<TemplateCtx> = (c) => {
  const s = sp(c, 0, 8);
  const wobble = Math.sin(c.frame / 4) * 6 * Math.max(0, 1 - c.frame / 30);
  return (
    <div style={{ ...at(c, 0.5, 0.35), transform: `translate(-50%,-50%) scale(${s}) rotate(${wobble}deg)`, fontSize: num(c.o, "size", 160) * unit(c), lineHeight: 1, fontFamily: fontStack("Inter"), filter: "drop-shadow(0 10px 20px rgba(0,0,0,0.35))" }}>
      {str(c.o, "emoji", "🔥")}
    </div>
  );
};

const Callout: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const bx = (c.o.x ?? 0.3) * c.W, by = (c.o.y ?? 0.25) * c.H;
  const tx = num(c.o, "targetX", 0.6) * c.W, ty = num(c.o, "targetY", 0.5) * c.H;
  const len = Math.hypot(tx - bx, ty - by);
  const draw = clamp01((c.frame - 6) / 12);
  const ang = Math.atan2(ty - by, tx - bx);
  const head = 26 * u;
  const pulse = 1 + 0.15 * Math.sin(c.frame / 5);
  return (
    <>
      <svg width={c.W} height={c.H} style={{ position: "absolute", inset: 0 }}>
        <line x1={bx} y1={by} x2={tx} y2={ty} stroke={c.o.accent} strokeWidth={8 * u} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - draw)} />
        {draw >= 1 ? (
          <>
            <path d={`M${tx},${ty} L${tx - head * Math.cos(ang - 0.45)},${ty - head * Math.sin(ang - 0.45)} M${tx},${ty} L${tx - head * Math.cos(ang + 0.45)},${ty - head * Math.sin(ang + 0.45)}`} stroke={c.o.accent} strokeWidth={8 * u} strokeLinecap="round" fill="none" />
            <circle cx={tx} cy={ty} r={30 * u * pulse} fill="none" stroke={c.o.accent} strokeWidth={5 * u} opacity={0.8} />
          </>
        ) : null}
      </svg>
      <div style={{ position: "absolute", left: bx, top: by, transform: `translate(-50%,-50%) scale(${sp(c)})`, background: c.o.accent, color: "#111", fontFamily: font(c, "Montserrat"), fontWeight: 900, fontSize: 44 * u, padding: `${12 * u}px ${24 * u}px`, borderRadius: 14 * u, boxShadow: shadow, whiteSpace: "nowrap" }}>
        {str(c.o, "text", "Look here")}
      </div>
    </>
  );
};

const Counter: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const from = num(c.o, "from", 0), to = num(c.o, "to", 100), dec = num(c.o, "decimals", 0);
  const p = interpolate(c.frame, [0, Math.max(2, c.dur * 0.7)], [0, 1], { extrapolateRight: "clamp", easing: (x) => 1 - Math.pow(1 - x, 4) });
  const v = from + (to - from) * p;
  const text = v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const label = str(c.o, "label");
  return (
    <div style={{ ...at(c, 0.5, 0.4), transform: `translate(-50%,-50%) scale(${0.85 + 0.15 * sp(c)})`, textAlign: "center" }}>
      <div style={{ fontFamily: font(c, "Anton"), fontSize: 180 * u, color: "#fff", lineHeight: 1, textShadow: `0 8px 0 ${c.o.accent}, 0 18px 40px rgba(0,0,0,0.45)`, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        {str(c.o, "prefix")}{text}{str(c.o, "suffix")}
      </div>
      {label ? <div style={{ fontFamily: font(c, "Montserrat"), fontWeight: 800, fontSize: 44 * u, color: "#fff", marginTop: 16 * u, textShadow: shadow, opacity: clamp01((c.frame - 8) / 8) }}>{label}</div> : null}
    </div>
  );
};

const ListItem: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const s = sp(c, 0, 10);
  const slide = clamp01((c.frame - 5) / 10);
  return (
    <div style={{ ...at(c, 0.08, 0.3), display: "flex", alignItems: "center", gap: 24 * u, transform: "translateY(-50%)" }}>
      <div style={{ width: 110 * u, height: 110 * u, borderRadius: "50%", background: c.o.accent, color: "#111", display: "grid", placeItems: "center", fontFamily: font(c, "Anton"), fontSize: 70 * u, transform: `scale(${s})`, boxShadow: shadow }}>
        {str(c.o, "number", "1")}
      </div>
      <div style={{ fontFamily: font(c, "Montserrat"), fontWeight: 800, fontSize: 60 * u, color: "#fff", textShadow: shadow, opacity: slide, transform: `translateX(${(1 - slide) * -40 * u}px)`, maxWidth: c.W * 0.7 }}>
        {str(c.o, "text", "List item")}
      </div>
    </div>
  );
};

const Quote: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const words = str(c.o, "text", "Quote").split(/\s+/);
  const author = str(c.o, "author");
  return (
    <div style={{ ...at(c, 0.5, 0.45), transform: "translate(-50%,-50%)", width: c.W * 0.8, textAlign: "center" }}>
      <div style={{ fontFamily: fontStack("Playfair Display"), fontSize: 220 * u, lineHeight: 0.6, color: c.o.accent, transform: `scale(${sp(c)})` }}>“</div>
      <div style={{ fontFamily: font(c, "Playfair Display"), fontStyle: "italic", fontSize: 64 * u, color: "#fff", lineHeight: 1.25, textShadow: shadow }}>
        {words.map((w, i) => (
          <span key={i} style={{ opacity: clamp01((c.frame - 6 - i * 2) / 6) }}>{w} </span>
        ))}
      </div>
      {author ? <div style={{ fontFamily: font(c, "Inter"), fontSize: 36 * u, color: "#ddd", marginTop: 24 * u, opacity: clamp01((c.frame - 10 - words.length * 2) / 8) }}>— {author}</div> : null}
    </div>
  );
};

const Chapter: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const n = str(c.o, "number");
  const line = clamp01(c.frame / 14);
  return (
    <div style={{ ...at(c, 0.5, 0.5), transform: "translate(-50%,-50%)", textAlign: "center" }}>
      {n ? <div style={{ fontFamily: font(c, "Inter"), fontWeight: 700, fontSize: 30 * u, letterSpacing: 10 * u, color: c.o.accent, opacity: line }}>CHAPTER {n}</div> : null}
      <div style={{ height: 4 * u, width: 420 * u * line, background: "#fff", margin: `${14 * u}px auto` }} />
      <div style={{ fontFamily: font(c, "Montserrat"), fontWeight: 900, fontSize: 84 * u, color: "#fff", textShadow: shadow, clipPath: `inset(0 ${(1 - clamp01((c.frame - 6) / 12)) * 100}% 0 0)`, whiteSpace: "nowrap" }}>
        {str(c.o, "title", "Chapter")}
      </div>
    </div>
  );
};

const SocialHandle: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const s = sp(c, 0, 13);
  const platform = str(c.o, "platform");
  return (
    <div style={{ ...at(c, 0.5, 0.86), transform: `translate(-50%,-50%) translateY(${(1 - s) * 80 * u}px)`, opacity: clamp01(s * 1.4), display: "flex", alignItems: "center", gap: 14 * u, background: "rgba(10,10,14,0.85)", borderRadius: 999, padding: `${10 * u}px ${30 * u}px ${10 * u}px ${10 * u}px`, boxShadow: shadow }}>
      {c.img(str(c.o, "avatar", c.brand.avatar ?? "")) ? (
        <Avatar c={c} size={64 * u} label={handleOf(c)} />
      ) : (
        <div style={{ width: 64 * u, height: 64 * u, borderRadius: "50%", background: c.o.accent, color: "#111", display: "grid", placeItems: "center", fontFamily: font(c, "Montserrat"), fontWeight: 900, fontSize: 38 * u }}>@</div>
      )}
      <div>
        {platform ? <div style={{ fontFamily: font(c, "Inter"), fontSize: 24 * u, color: "#bbb", fontWeight: 600 }}>{platform}</div> : null}
        <div style={{ fontFamily: font(c, "Montserrat"), fontSize: 40 * u, color: "#fff", fontWeight: 800 }}>{handleOf(c, "@handle")}</div>
      </div>
    </div>
  );
};

/** Split a long slam phrase into two balanced lines ("STUDYING / WRONG?") so it can stay big. */
export function keywordLines(text: string): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || text.length <= 11) return [words.join(" ")];
  let best = [text];
  let bestLen = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const pair = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    const len = Math.max(pair[0]!.length, pair[1]!.length);
    if (len < bestLen) {
      bestLen = len;
      best = pair;
    }
  }
  return best;
}

const Keyword: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const slam = interpolate(c.frame, [0, 4], [3, 1], { extrapolateRight: "clamp", easing: (x) => x * x });
  const shake = c.frame < 10 ? (random(`k${c.frame}`) - 0.5) * 24 * u * (1 - c.frame / 10) : 0;
  const lines = keywordLines(str(c.o, "text", "WOW"));
  // Anton capitals are ~0.45 em wide (+ stroke/shadow): keep the longest line inside 86% of the frame width.
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const size = Math.min(170 * u, (0.86 * c.W) / (longest * 0.5));
  return (
    <div style={{ ...at(c, 0.5, 0.45), transform: `translate(-50%,-50%) translate(${shake}px, ${-shake}px) rotate(${num(c.o, "rotate", -4)}deg) scale(${slam})`, opacity: clamp01(c.frame / 2) }}>
      <div style={{ fontFamily: font(c, "Anton"), fontSize: size, color: "#fff", textTransform: "uppercase", lineHeight: 1, textAlign: "center", WebkitTextStroke: `${(8 * size) / 170}px #000`, paintOrder: "stroke fill", textShadow: `${(10 * size) / 170}px ${(10 * size) / 170}px 0 ${c.o.accent}`, whiteSpace: "nowrap" }}>
        {lines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
};

const Countdown: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const from = Math.max(1, Math.round(num(c.o, "from", 3)));
  const per = c.dur / from;
  const idx = Math.min(from - 1, Math.floor(c.frame / per));
  const local = c.frame - idx * per;
  const s = spring({ frame: local, fps: c.fps, config: { damping: 10, stiffness: 200 } });
  const r = 150 * u;
  const circ = 2 * Math.PI * r;
  return (
    <div style={{ ...at(c, 0.5, 0.45), transform: "translate(-50%,-50%)", width: r * 2.4, height: r * 2.4, display: "grid", placeItems: "center" }}>
      <svg width={r * 2.4} height={r * 2.4} style={{ position: "absolute", transform: "rotate(-90deg)" }}>
        <circle cx={r * 1.2} cy={r * 1.2} r={r} fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.2)" strokeWidth={14 * u} />
        <circle cx={r * 1.2} cy={r * 1.2} r={r} fill="none" stroke={c.o.accent} strokeWidth={14 * u} strokeDasharray={circ} strokeDashoffset={circ * (local / per)} strokeLinecap="round" />
      </svg>
      <div style={{ fontFamily: font(c, "Anton"), fontSize: 190 * u, color: "#fff", transform: `scale(${s})`, lineHeight: 1 }}>{from - idx}</div>
    </div>
  );
};

export const TEMPLATE_COMPONENTS: Record<TemplateOverlay["template"], React.FC<TemplateCtx>> = {
  titleCard: TitleCard,
  lowerThird: LowerThird,
  subscribe: Subscribe,
  progressBar: ProgressBar,
  emojiPop: EmojiPop,
  callout: Callout,
  counter: Counter,
  listItem: ListItem,
  quote: Quote,
  chapter: Chapter,
  socialHandle: SocialHandle,
  keyword: Keyword,
  countdown: Countdown,
  ...SOCIAL_TEMPLATES,
};
