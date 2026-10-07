// Faceless / social formats: post card, text-message chat, versus, end screen, animated background, Q&A sticker.
// Original designs — generic shapes and icons, no platform logos or trademarks.
import type React from "react";
import { Img, random } from "remotion";
import {
  Avatar, at, bool, clamp01, compact, easeOut3, font, handleOf, nameOf, num, shadow, sp, str, type TemplateCtx, unit,
} from "./template-kit";
import { chatTimes, parseChat } from "../shared/chat";

const Icon: React.FC<{ d: string; size: number; color: string; fill?: boolean }> = ({ d, size, color, fill }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ flex: "none" }}>
    <path d={d} fill={fill ? color : "none"} stroke={color} strokeWidth={fill ? 0 : 2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ICONS = {
  up: "M12 4l7 8h-4v8H9v-8H5z",
  down: "M12 20l-7-8h4V4h6v8h4z",
  bubble: "M4 5h16v11H9l-5 4z",
  share: "M14 5l6 6-6 6M20 11H9a5 5 0 0 0-5 5v2",
  repost: "M7 7h10l-3-3M17 17H7l3 3M17 7v5M7 17v-5",
  heart: "M12 20s-7-4.4-9-8.6C1.5 8 3.6 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.5 3.5 4 6.9C19 15.6 12 20 12 20z",
  views: "M5 20V10M10 20V4M15 20v-7M20 20v-11",
  check: "M5 12.5l4.5 4.5L19 7.5",
  play: "M8 5v14l11-7z",
};

// ---------------------------------------------------------------- post card (forum thread / social post)

const PostCard: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const social = str(c.o, "style", "forum") === "social";
  const dark = str(c.o, "theme", social ? "dark" : "light") === "dark";
  const bg = dark ? "#16181C" : "#FFFFFF";
  const fg = dark ? "#E7E9EA" : "#0F1419";
  const dim = dark ? "#8B98A5" : "#5B6B73";
  const pill = dark ? "#23272C" : "#EEF1F3";
  const enter = sp(c, 0, 14);
  const user = nameOf(c, social ? "Anonymous" : "throwaway_account");
  const community = str(c.o, "community");
  const time = str(c.o, "time", social ? "2h" : "5h ago");
  const title = str(c.o, "title", social ? "" : "My post title goes here");
  const body = str(c.o, "body", str(c.o, "text", social ? "Write the post text in the `text` prop." : ""));
  const head = social ? body : title;
  const rest = social ? "" : body;
  const words = head.split(/\s+/).filter(Boolean);
  const shown = Math.max(0, Math.floor((c.frame - 6) / 1.1));
  const tick = easeOut3((c.frame - 8) / (1.2 * c.fps));
  const hit = c.frame > 0.9 * c.fps;
  const liked = hit && bool(c.o, "liked", true);
  const heartPop = liked ? 1 + 0.35 * Math.max(0, 1 - (c.frame - 0.9 * c.fps) / 8) : 1;
  const w = Math.min(0.86 * c.W, 980 * u);
  const metric = (icon: string, value: string, color = dim, fillIcon = false, scale = 1) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10 * u, background: social ? "transparent" : pill, borderRadius: 999, padding: social ? 0 : `${10 * u}px ${20 * u}px` }}>
      <div style={{ transform: `scale(${scale})`, display: "flex" }}><Icon d={icon} size={34 * u} color={color} fill={fillIcon} /></div>
      {value ? <span style={{ fontFamily: font(c, "Inter"), fontWeight: 700, fontSize: 30 * u, color: social ? color : fg }}>{value}</span> : null}
    </div>
  );
  return (
    <div style={{ ...at(c, 0.5, 0.42), transform: `translate(-50%,-50%) translateY(${(1 - enter) * 90 * u}px) scale(${0.9 + 0.1 * enter})`, opacity: clamp01(enter * 1.6), width: w, background: bg, borderRadius: 30 * u, padding: `${34 * u}px ${38 * u}px ${28 * u}px`, boxShadow: "0 24px 70px rgba(0,0,0,0.45)", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 * u, marginBottom: 22 * u }}>
        {/* A forum post is someone else's: only the explicit avatar prop, never the creator's brand picture. */}
        <Avatar c={social ? c : { ...c, brand: { ...c.brand, avatar: undefined } }} size={78 * u} label={social ? user : community || user} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 * u, fontFamily: font(c, "Inter"), fontWeight: 800, fontSize: 33 * u, color: fg, whiteSpace: "nowrap" }}>
            {social ? user : community || user}
            {social && bool(c.o, "verified") ? (
              <div style={{ width: 32 * u, height: 32 * u, borderRadius: "50%", background: "#1D9BF0", display: "grid", placeItems: "center" }}>
                <Icon d={ICONS.check} size={22 * u} color="#fff" />
              </div>
            ) : null}
          </div>
          <div style={{ fontFamily: font(c, "Inter"), fontSize: 27 * u, color: dim, whiteSpace: "nowrap" }}>
            {social ? `${handleOf(c, "@anonymous")} · ${time}` : `${community ? `u/${user} · ` : ""}${time}`}
          </div>
        </div>
      </div>
      <div style={{ fontFamily: font(c, social ? "Inter" : "Montserrat"), fontWeight: social ? 500 : 800, fontSize: (social ? 44 : 50) * u, lineHeight: 1.28, color: fg }}>
        {words.map((wd, i) => (
          <span key={i} style={{ opacity: i < shown ? 1 : 0 }}>{wd} </span>
        ))}
      </div>
      {rest ? (
        <div style={{ fontFamily: font(c, "Inter"), fontSize: 36 * u, lineHeight: 1.4, color: dim, marginTop: 16 * u, opacity: clamp01((c.frame - 6 - words.length * 1.1) / 8), display: "-webkit-box", WebkitLineClamp: num(c.o, "maxLines", 7), WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {rest}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: (social ? 0 : 16) * u, justifyContent: social ? "space-between" : "flex-start", marginTop: 26 * u, paddingTop: social ? 22 * u : 0, borderTop: social ? `${2 * u}px solid ${pill}` : undefined }}>
        {social ? (
          <>
            {metric(ICONS.bubble, compact(num(c.o, "comments", 842) * tick))}
            {metric(ICONS.repost, compact(num(c.o, "reposts", 1200) * tick))}
            {metric(ICONS.heart, compact(num(c.o, "votes", 12500) * tick), liked ? "#F91880" : dim, liked, heartPop)}
            {metric(ICONS.views, compact(num(c.o, "views", 480000) * tick))}
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10 * u, background: pill, borderRadius: 999, padding: `${10 * u}px ${18 * u}px` }}>
              <Icon d={ICONS.up} size={34 * u} color={hit ? "#FF4500" : dim} fill={hit} />
              <span style={{ fontFamily: font(c, "Inter"), fontWeight: 800, fontSize: 30 * u, color: fg }}>{compact(num(c.o, "votes", 12500) * tick)}</span>
              <Icon d={ICONS.down} size={34 * u} color={dim} />
            </div>
            {metric(ICONS.bubble, compact(num(c.o, "comments", 842) * tick))}
            {metric(ICONS.share, "Share")}
          </>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- text-message conversation

const Chat: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const dark = str(c.o, "theme", "dark") !== "light";
  const msgs = parseChat(str(c.o, "messages", "me: you up?|Sam: why…|me: I did something"));
  const times = chatTimes(msgs, c.dur / c.fps, c.o.props.perMessage === undefined ? undefined : num(c.o, "perMessage", 1.4));
  const typingFor = Math.max(0.2, Math.min(0.55, (times[1] ?? 1.2) - (times[0] ?? 0) - 0.15));
  const W = Math.min(0.9 * c.W, 980 * u);
  const H = num(c.o, "height", 0.64) * c.H;
  const header = 118 * u;
  const fs = 46 * u, padX = 30 * u, padY = 19 * u, gap = 15 * u, maxB = W * 0.76;
  const firstWho = msgs.find((x) => x.who)?.who;
  const group = msgs.some((m) => m.who && m.who !== firstWho);
  const meColor = str(c.o, "meColor", "#0A84FF");
  const themBg = dark ? "#2A2A31" : "#E9E9EB";
  const themFg = dark ? "#F2F2F7" : "#111";
  const sub = dark ? "#8E8E93" : "#6C6C70";
  const tSec = c.frame / c.fps;
  const typed = (i: number) => !msgs[i]!.me && i > 0;
  // Estimated bubble heights drive the auto-scroll (Inter is ~0.52em per character).
  const cpl = Math.max(6, Math.floor((maxB - padX * 2) / (fs * 0.52)));
  const label = (i: number) => group && !msgs[i]!.me && !!msgs[i]!.who && msgs[i - 1]?.who !== msgs[i]!.who;
  const heights = msgs.map((m, i) => {
    const lines = m.text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cpl)), 0);
    return lines * fs * 1.28 + padY * 2 + gap + (label(i) ? 34 * u : 0);
  });
  const typingH = fs * 1.28 + padY * 2 + gap;
  const room = H - header - 64 * u;
  // Each event (typing bubble appears / message lands) grows the stack; scroll eases to the new overflow.
  let stack = 0, prevOver = 0, scroll = 0;
  msgs.forEach((_, i) => {
    const events = typed(i)
      ? [{ f: (times[i]! - typingFor) * c.fps, d: typingH }, { f: times[i]! * c.fps, d: heights[i]! - typingH }]
      : [{ f: times[i]! * c.fps, d: heights[i]! }];
    for (const e of events) {
      stack += e.d;
      const over = Math.max(0, stack - room);
      scroll += (over - prevOver) * sp(c, e.f, 16);
      prevOver = over;
    }
  });
  const lastMe = msgs.reduce((best, m, i) => (m.me && tSec >= times[i]! ? i : best), -1);
  const contact = str(c.o, "contact", firstWho || "Unknown");
  const typingIdx = msgs.findIndex((_, i) => typed(i) && tSec >= times[i]! - typingFor && tSec < times[i]!);
  const enter = sp(c, 0, 15);
  const contactCtx: TemplateCtx = { ...c, o: { ...c.o, props: { ...c.o.props, avatar: str(c.o, "contactAvatar") } }, brand: { ...c.brand, avatar: undefined } };
  return (
    <div style={{ ...at(c, 0.5, 0.45), transform: `translate(-50%,-50%) scale(${0.92 + 0.08 * enter})`, opacity: clamp01(enter * 1.8), width: W, height: H, borderRadius: 40 * u, overflow: "hidden", background: dark ? "#0E0E12" : "#FFFFFF", boxShadow: "0 30px 80px rgba(0,0,0,0.5)", fontFamily: font(c, "Inter") }}>
      <div style={{ position: "absolute", top: header, left: 0, right: 0, bottom: 0, padding: `${20 * u}px ${24 * u}px`, overflow: "hidden" }}>
        <div style={{ transform: `translateY(${-scroll}px)`, display: "flex", flexDirection: "column" }}>
          {msgs.map((m, i) => {
            const t0 = times[i]!;
            if (tSec < t0) return null;
            const s = sp(c, t0 * c.fps, 13);
            return (
              <div key={i} style={{ alignSelf: m.me ? "flex-end" : "flex-start", maxWidth: maxB, marginBottom: gap, display: "flex", flexDirection: "column", alignItems: m.me ? "flex-end" : "flex-start" }}>
                {label(i) ? <div style={{ fontSize: 24 * u, color: sub, margin: `0 0 ${6 * u}px ${padX}px`, fontWeight: 600 }}>{m.who}</div> : null}
                <div style={{ background: m.me ? meColor : themBg, color: m.me ? "#fff" : themFg, fontSize: fs, lineHeight: 1.28, padding: `${padY}px ${padX}px`, borderRadius: 34 * u, borderBottomRightRadius: m.me ? 10 * u : 34 * u, borderBottomLeftRadius: m.me ? 34 * u : 10 * u, transform: `scale(${0.4 + 0.6 * s}) translateY(${(1 - s) * 20 * u}px)`, transformOrigin: m.me ? "100% 100%" : "0% 100%", opacity: clamp01(s * 2), whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {m.text}
                </div>
                {i === lastMe && tSec >= t0 + 0.4 ? <div style={{ fontSize: 22 * u, color: sub, marginTop: 6 * u, opacity: clamp01((tSec - t0 - 0.4) * 4) }}>{str(c.o, "status", "Delivered")}</div> : null}
              </div>
            );
          })}
          {typingIdx >= 0 ? (
            <div style={{ alignSelf: "flex-start", background: themBg, borderRadius: 34 * u, borderBottomLeftRadius: 10 * u, height: fs * 1.28 + padY * 2, padding: `0 ${padX}px`, display: "flex", alignItems: "center", gap: 10 * u, transform: `scale(${0.5 + 0.5 * sp(c, (times[typingIdx]! - typingFor) * c.fps, 14)})`, transformOrigin: "0% 100%" }}>
              {[0, 1, 2].map((k) => (
                <div key={k} style={{ width: 16 * u, height: 16 * u, borderRadius: "50%", background: sub, transform: `translateY(${Math.sin(c.frame * 0.35 - k * 0.9) * 6 * u}px)`, opacity: 0.55 + 0.45 * Math.sin(c.frame * 0.35 - k * 0.9) ** 2 }} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: header, background: dark ? "rgba(28,28,34,0.96)" : "rgba(246,246,248,0.96)", display: "flex", alignItems: "center", gap: 18 * u, padding: `0 ${30 * u}px`, borderBottom: `${2 * u}px solid ${dark ? "#26262C" : "#E0E0E5"}` }}>
        <Avatar c={contactCtx} size={70 * u} label={contact} />
        <div>
          <div style={{ fontWeight: 800, fontSize: 34 * u, color: dark ? "#fff" : "#111" }}>{contact}</div>
          <div style={{ fontSize: 24 * u, color: typingIdx >= 0 ? "#34C759" : sub }}>{typingIdx >= 0 ? "typing…" : str(c.o, "subtitle", "online")}</div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- versus

const Versus: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const tall = c.H >= c.W;
  const A = str(c.o, "left", "THIS"), B = str(c.o, "right", "THAT");
  const ca = str(c.o, "leftColor", "#FF3B5C"), cb = str(c.o, "rightColor", "#2F7BFF");
  const ia = c.img(str(c.o, "leftImage")), ib = c.img(str(c.o, "rightImage"));
  const sa = sp(c, 0, 15), sb = sp(c, 3, 15);
  const impact = Math.round(0.45 * c.fps);
  const slam = c.frame < impact ? 0 : clamp01((c.frame - impact) / 5);
  const vsScale = c.frame < impact ? 0 : 3 - 2 * slam * slam;
  const shake = c.frame >= impact + 5 && c.frame < impact + 15 ? (random(`vs${c.frame}`) - 0.5) * 26 * u * (1 - (c.frame - impact - 5) / 10) : 0;
  const ring = clamp01((c.frame - impact - 5) / 14);
  // Diagonal seam: tall -> (0, 54%) to (100%, 46%); wide -> (54%, 0) to (46%, 100%).
  const clipA = tall ? "polygon(0 0, 100% 0, 100% 46%, 0 54%)" : "polygon(0 0, 54% 0, 46% 100%, 0 100%)";
  const clipB = tall ? "polygon(0 54%, 100% 46%, 100% 100%, 0 100%)" : "polygon(54% 0, 100% 0, 100% 100%, 46% 100%)";
  const offA = tall ? `translateY(${(sa - 1) * 100}%)` : `translateX(${(sa - 1) * 100}%)`;
  const offB = tall ? `translateY(${(1 - sb) * 100}%)` : `translateX(${(1 - sb) * 100}%)`;
  const panel = (img: string | undefined, col: string, clip: string, off: string) => (
    <div style={{ position: "absolute", inset: 0, transform: off }}>
      <div style={{ position: "absolute", inset: 0, clipPath: clip, background: `linear-gradient(135deg, ${col}, #0B0B12 140%)` }}>
        {img ? <Img src={img} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} /> : null}
        {img ? <div style={{ position: "absolute", inset: 0, background: col, opacity: 0.35, mixBlendMode: "multiply" }} /> : null}
      </div>
    </div>
  );
  const label = (text: string, sub: string, x: number, y: number, s: number) => (
    <div style={{ position: "absolute", left: x * c.W, top: y * c.H, transform: `translate(-50%,-50%) scale(${0.6 + 0.4 * s})`, opacity: clamp01(s * 1.5), textAlign: "center", width: c.W * (tall ? 0.9 : 0.42) }}>
      <div style={{ fontFamily: font(c, "Anton"), fontSize: 130 * u, color: "#fff", lineHeight: 1, textTransform: "uppercase", textShadow: "0 10px 30px rgba(0,0,0,0.55)" }}>{text}</div>
      {sub ? <div style={{ fontFamily: font(c, "Montserrat"), fontWeight: 800, fontSize: 40 * u, color: "rgba(255,255,255,0.9)", marginTop: 12 * u, textShadow: shadow }}>{sub}</div> : null}
    </div>
  );
  const cx = c.W / 2, cy = c.H / 2;
  return (
    <div style={{ position: "absolute", inset: 0, transform: `translate(${shake}px, ${-shake * 0.6}px)` }}>
      {panel(ia, ca, clipA, offA)}
      {panel(ib, cb, clipB, offB)}
      {label(A, str(c.o, "leftSub"), tall ? 0.5 : 0.25, tall ? 0.24 : 0.5, sp(c, 6))}
      {label(B, str(c.o, "rightSub"), tall ? 0.5 : 0.75, tall ? 0.76 : 0.5, sp(c, 9))}
      <svg width={c.W} height={c.H} style={{ position: "absolute", inset: 0 }}>
        <line x1={tall ? 0 : c.W * 0.54} y1={tall ? c.H * 0.54 : 0} x2={tall ? c.W : c.W * 0.46} y2={tall ? c.H * 0.46 : c.H} stroke="#fff" strokeWidth={8 * u} opacity={slam} />
        {ring > 0 && ring < 1 ? <circle cx={cx} cy={cy} r={(130 + 380 * ring) * u} fill="none" stroke="#fff" strokeWidth={10 * u * (1 - ring)} opacity={1 - ring} /> : null}
      </svg>
      {vsScale > 0 ? (
        <div style={{ position: "absolute", left: cx, top: cy, width: 230 * u, height: 230 * u, transform: `translate(-50%,-50%) scale(${vsScale}) rotate(-8deg)`, borderRadius: "50%", background: "#111", border: `${10 * u}px solid #fff`, boxSizing: "border-box", display: "grid", placeItems: "center", boxShadow: "0 16px 50px rgba(0,0,0,0.6)" }}>
          <span style={{ fontFamily: font(c, "Anton"), fontSize: 120 * u, color: c.o.accent, lineHeight: 1 }}>VS</span>
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------- end screen

const EndScreen: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const tall = c.H >= c.W;
  const handle = handleOf(c);
  const pulse = 1 + 0.06 * Math.sin(c.frame / 6);
  const slots = tall ? 1 : 2;
  const slotW = tall ? 0.78 * c.W : 0.34 * c.W;
  const slotH = slotW * (tall ? 0.62 : 9 / 16);
  const cta = str(c.o, "cta", tall ? "FOLLOW FOR PART 2" : "SUBSCRIBE");
  const titleS = sp(c, 2);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at center, rgba(10,10,16,0.72), rgba(0,0,0,0.92))", opacity: clamp01(c.frame / 10) }} />
      <div style={{ position: "absolute", left: "50%", top: (tall ? 0.16 : 0.13) * c.H, transform: `translate(-50%,-50%) translateY(${(1 - titleS) * -40 * u}px)`, opacity: clamp01(titleS * 1.5), fontFamily: font(c, "Montserrat"), fontWeight: 900, fontSize: 70 * u, letterSpacing: 4 * u, color: "#fff", whiteSpace: "nowrap", textShadow: shadow }}>
        {str(c.o, "title", "WATCH NEXT")}
      </div>
      {Array.from({ length: slots }, (_, i) => {
        const s = sp(c, 5 + i * 4, 13);
        const x = tall ? 0.5 * c.W : (i === 0 ? 0.29 : 0.71) * c.W;
        const y = (tall ? 0.38 : 0.45) * c.H;
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y, width: slotW, height: slotH, transform: `translate(-50%,-50%) scale(${0.7 + 0.3 * s})`, opacity: clamp01(s * 1.6) }}>
            <svg width={slotW} height={slotH} style={{ position: "absolute", inset: 0 }}>
              <rect x={3 * u} y={3 * u} width={slotW - 6 * u} height={slotH - 6 * u} rx={28 * u} fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.75)" strokeWidth={5 * u} strokeDasharray={`${22 * u} ${16 * u}`} strokeDashoffset={-c.frame * 2 * u} />
            </svg>
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ width: 110 * u, height: 110 * u, borderRadius: "50%", background: c.o.accent, display: "grid", placeItems: "center", margin: "0 auto" }}>
                  <Icon d={ICONS.play} size={56 * u} color="#111" fill />
                </div>
                <div style={{ fontFamily: font(c, "Montserrat"), fontWeight: 800, fontSize: 38 * u, color: "#fff", marginTop: 18 * u }}>{str(c.o, i === 0 ? "next" : "next2", i === 0 ? "Next video" : "Best of the channel")}</div>
              </div>
            </div>
          </div>
        );
      })}
      <div style={{ position: "absolute", left: "50%", top: (tall ? 0.7 : 0.8) * c.H, transform: `translate(-50%,-50%) scale(${sp(c, 10, 11)})`, display: "flex", flexDirection: tall ? "column" : "row", alignItems: "center", gap: 24 * u }}>
        <div style={{ transform: `scale(${pulse})` }}><Avatar c={c} size={(tall ? 190 : 150) * u} label={handle} ring={c.o.accent} /></div>
        <div style={{ textAlign: tall ? "center" : "left" }}>
          <div style={{ fontFamily: font(c, "Montserrat"), fontWeight: 900, fontSize: 52 * u, color: "#fff", textShadow: shadow }}>{handle}</div>
          <div style={{ display: "inline-block", marginTop: 14 * u, background: str(c.o, "ctaColor", "#FF0033"), color: "#fff", fontFamily: font(c, "Montserrat"), fontWeight: 900, fontSize: 36 * u, padding: `${14 * u}px ${34 * u}px`, borderRadius: 14 * u, letterSpacing: 1, transform: `translateY(${Math.sin(c.frame / 5) * 4 * u}px)` }}>{cta}</div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- animated background (cheap: gradients + SVG, no CSS blur)

const Background: React.FC<TemplateCtx> = (c) => {
  const t = (c.frame / c.fps) * num(c.o, "speed", 1);
  const style = str(c.o, "style", "gradient");
  const a = c.o.accent, b = str(c.o, "color2", c.brand.colors[1] ?? "#FF2D95"), base = str(c.o, "color3", "#0A0A14");
  if (style === "rays") {
    const cx = (c.o.x ?? 0.5) * 100, cy = (c.o.y ?? 0.45) * 100;
    const d = Math.hypot(c.W, c.H) * 2;
    return (
      <div style={{ position: "absolute", inset: 0, background: base, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: `${cx}%`, top: `${cy}%`, width: d, height: d, transform: `translate(-50%,-50%) rotate(${t * 12}deg)`, background: `repeating-conic-gradient(${a} 0deg 9deg, ${b} 9deg 18deg)`, opacity: 0.85 }} />
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at ${cx}% ${cy}%, transparent 0%, ${base}cc 55%, ${base} 85%)` }} />
      </div>
    );
  }
  if (style === "grid") {
    const horizon = c.H * 0.52;
    const rows = 14;
    const lines: React.ReactNode[] = [];
    for (let i = 0; i < rows; i++) {
      const z = ((i + ((t * 1.2) % 1)) / rows) ** 2.2; // 0 at the horizon -> 1 at the bottom
      const y = horizon + z * (c.H - horizon);
      lines.push(<line key={`h${i}`} x1={0} x2={c.W} y1={y} y2={y} stroke={b} strokeWidth={1 + 4 * z} opacity={0.25 + 0.75 * z} />);
    }
    for (let i = -10; i <= 10; i++) {
      lines.push(<line key={`v${i}`} x1={c.W / 2 + i * c.W * 0.02} y1={horizon} x2={c.W / 2 + i * c.W * 0.22} y2={c.H} stroke={b} strokeWidth={2} opacity={0.7} />);
    }
    const sun = c.W * 0.46;
    return (
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to bottom, ${base} 0%, #1a0b2e ${(horizon / c.H) * 100}%, ${base} 100%)` }}>
        <div style={{ position: "absolute", left: "50%", top: horizon - sun * 0.62, width: sun, height: sun, transform: "translateX(-50%)", borderRadius: "50%", background: `linear-gradient(to bottom, ${a}, ${b})`, clipPath: "inset(0 0 38% 0)" }} />
        <svg width={c.W} height={c.H} style={{ position: "absolute", inset: 0 }}>{lines}</svg>
        <div style={{ position: "absolute", left: 0, right: 0, top: horizon - 3, height: 6, background: b, boxShadow: `0 0 40px 10px ${b}` }} />
      </div>
    );
  }
  if (style === "particles") {
    const dots = Array.from({ length: 70 }, (_, i) => {
      const x = random(`px${i}`) * c.W;
      const speed = 0.04 + random(`ps${i}`) * 0.1;
      const y = ((((random(`py${i}`) - t * speed) % 1) + 1) % 1) * c.H;
      const r = (2 + random(`pr${i}`) * 7) * unit(c);
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * (1 + random(`pt${i}`) * 2) + i));
      return <circle key={i} cx={x + Math.sin(t + i) * 12} cy={y} r={r} fill={i % 3 === 0 ? a : "#ffffff"} opacity={tw} />;
    });
    return (
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse at 50% 30%, ${b}55, ${base} 70%)` }}>
        <svg width={c.W} height={c.H} style={{ position: "absolute", inset: 0 }}>{dots}</svg>
      </div>
    );
  }
  if (style === "aurora") {
    const band = (col: string, k: number) => (
      <div key={k} style={{ position: "absolute", left: "-30%", width: "160%", height: "45%", top: `${15 + k * 18 + Math.sin(t * 0.6 + k * 2) * 8}%`, transform: `rotate(${-12 + k * 9 + Math.sin(t * 0.4 + k) * 6}deg)`, background: `radial-gradient(ellipse at center, ${col}99 0%, ${col}44 40%, transparent 70%)`, mixBlendMode: "screen" }} />
    );
    return <div style={{ position: "absolute", inset: 0, background: base, overflow: "hidden" }}>{[a, b, "#36F1CD"].map(band)}</div>;
  }
  // "gradient": drifting colour blobs (stacked radial gradients).
  const blob = (col: string, k: number) => {
    const x = 50 + 35 * Math.sin(t * (0.35 + k * 0.11) + k * 1.7);
    const y = 50 + 35 * Math.cos(t * (0.28 + k * 0.09) + k * 2.3);
    return `radial-gradient(circle at ${x.toFixed(1)}% ${y.toFixed(1)}%, ${col} 0%, transparent 48%)`;
  };
  const cols = [a, b, c.brand.colors[2] ?? "#3D5AFE", c.brand.colors[3] ?? "#00D1B2"];
  return <div style={{ position: "absolute", inset: 0, background: `${cols.map(blob).join(", ")}, ${base}` }} />;
};

// ---------------------------------------------------------------- Q&A sticker

const Question: React.FC<TemplateCtx> = (c) => {
  const u = unit(c);
  const s = sp(c, 0, 10);
  const w = Math.min(0.74 * c.W, 780 * u);
  const words = str(c.o, "text", "What's one thing you wish you knew earlier?").split(/\s+/);
  return (
    <div style={{ ...at(c, 0.5, 0.4), transform: `translate(-50%,-50%) scale(${s}) rotate(${num(c.o, "rotate", -3)}deg)`, width: w, boxShadow: "0 24px 60px rgba(0,0,0,0.45)", borderRadius: 34 * u }}>
      <div style={{ position: "absolute", left: "50%", top: 0, transform: "translate(-50%,-55%)" }}>
        <Avatar c={c} size={104 * u} label={handleOf(c)} ring="#fff" />
      </div>
      <div style={{ background: `linear-gradient(120deg, ${c.o.accent}, ${str(c.o, "color2", "#FF2D95")})`, borderRadius: `${34 * u}px ${34 * u}px 0 0`, padding: `${70 * u}px ${30 * u}px ${26 * u}px`, textAlign: "center", fontFamily: font(c, "Montserrat"), fontWeight: 800, fontSize: 36 * u, color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,0.25)" }}>
        {str(c.o, "header", "Ask me anything")}
      </div>
      <div style={{ background: "#fff", borderRadius: `0 0 ${34 * u}px ${34 * u}px`, padding: `${34 * u}px ${36 * u}px ${40 * u}px`, textAlign: "center", fontFamily: font(c, "Montserrat"), fontWeight: 800, fontSize: 52 * u, lineHeight: 1.22, color: "#111" }}>
        {words.map((wd, i) => (
          <span key={i} style={{ opacity: clamp01((c.frame - 8 - i * 1.5) / 4) }}>{wd} </span>
        ))}
      </div>
    </div>
  );
};

export const SOCIAL_TEMPLATES = {
  postCard: PostCard,
  chat: Chat,
  versus: Versus,
  endScreen: EndScreen,
  background: Background,
  question: Question,
} satisfies Record<string, React.FC<TemplateCtx>>;
