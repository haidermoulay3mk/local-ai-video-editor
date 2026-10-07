// Live preview: the SAME composition that renders the final MP4, inside a fitted "monitor".
import { Player, type PlayerRef } from "@remotion/player";
import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Main } from "../remotion/Main";
import { CAPTION_STYLES, type CompositionProps, GRADE_PRESETS, type Spec } from "../shared/spec";
import { totalFrames } from "../shared/timeline";
import { api, fmtTimecode, type Project } from "./api";

function useFit(ref: React.RefObject<HTMLDivElement | null>, aspect: number) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e!.contentRect;
      const w = Math.min(width, height * aspect);
      setSize({ w: Math.floor(w), h: Math.floor(w / aspect) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, aspect]);
  return size;
}

export function Monitor(p: {
  project: Project;
  props: CompositionProps | null;
  playerRef: React.RefObject<PlayerRef | null>;
  frame: number;
  setFrame: (f: number) => void;
}) {
  const { project, props, playerRef, frame, setFrame } = p;
  const spec = props?.spec ?? project.spec;
  const { width, height, fps } = spec.format;
  const stageRef = useRef<HTMLDivElement>(null);
  const size = useFit(stageRef, width / height);
  const duration = totalFrames(spec);
  const hasContent = spec.clips.length > 0 || spec.overlays.length > 0;

  useEffect(() => {
    const pl = playerRef.current;
    if (!pl) return;
    let raf = 0;
    const on = (e: { detail: { frame: number } }) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setFrame(e.detail.frame));
    };
    pl.addEventListener("frameupdate", on);
    return () => {
      pl.removeEventListener("frameupdate", on);
      cancelAnimationFrame(raf);
    };
  }, [playerRef, setFrame, props, size.w]);

  return (
    <div className="monitor">
      <div className="slate">
        <span className="dot amber" />
        <span className="tc">{fmtTimecode(frame, fps)}</span>
        <span>/ {fmtTimecode(duration, fps)}</span>
        <span className="spacer" />
        <span>{width}×{height}</span>
        <span>{fps} fps</span>
        <span>{spec.clips.length} clips · {spec.overlays.length} graphics</span>
      </div>
      <div className="stage" ref={stageRef}>
        {props && hasContent && size.w > 0 ? (
          <div className="screen" style={{ width: size.w, height: size.h }}>
            <Player
              ref={playerRef}
              component={Main}
              inputProps={props}
              durationInFrames={duration}
              compositionWidth={width}
              compositionHeight={height}
              fps={fps}
              controls
              acknowledgeRemotionLicense
              doubleClickToFullscreen
              spaceKeyToPlayOrPause
              style={{ width: size.w, height: size.h }}
            />
          </div>
        ) : (
          <div className="screen-empty">
            <div className="big">{project.media.length ? "Ready when you are." : "Your cut appears here."}</div>
            <p>
              {project.media.length
                ? "Tell Claude what you want in the panel on the right — or pick a recipe if you're not sure how to ask."
                : "Add your video on the left. The editor will transcribe it, find the pauses and track your face — all on this PC."}
            </p>
          </div>
        )}
      </div>
      <QuickControls project={project} spec={spec} />
    </div>
  );
}

function QuickControls({ project, spec }: { project: Project; spec: Spec }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [smooth, setSmooth] = useState(spec.retouch.skinSmooth);
  const [light, setLight] = useState(spec.retouch.faceLight);
  useEffect(() => {
    setSmooth(spec.retouch.skinSmooth);
    setLight(spec.retouch.faceLight);
  }, [spec.retouch.skinSmooth, spec.retouch.faceLight]);

  const edit = async (fn: (s: Spec) => void, reason: string) => {
    const next = structuredClone(spec);
    fn(next);
    setBusy(true);
    try {
      const r = await api.putSpec(project.id, next, reason);
      setErr(r.ok ? null : r.errors.join(" · "));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const hasFace = project.media.some((m) => m.kind === "video");
  const hasVoice = project.media.some((m) => m.enhanced);

  return (
    <div className="quick">
      <label className="ctl">
        Captions
        <select className="field" disabled={busy} value={spec.captions.enabled ? spec.captions.style : "off"}
          onChange={(e) => void edit((s) => {
            if (e.target.value === "off") s.captions.enabled = false;
            else {
              s.captions.enabled = true;
              s.captions.style = e.target.value as Spec["captions"]["style"];
            }
          }, "captions style")}>
          <option value="off">Off</option>
          {CAPTION_STYLES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="ctl">
        Look
        <select className="field" disabled={busy} value={spec.grade.preset}
          onChange={(e) => void edit((s) => { s.grade.preset = e.target.value as Spec["grade"]["preset"]; }, "grade preset")}>
          {GRADE_PRESETS.map((g) => <option key={g} value={g}>{g.replace("_", " ")}</option>)}
        </select>
      </label>
      <label className="ctl check" title={hasVoice ? "Denoise + loudness for speech" : "Available once a video with sound is processed"}>
        <input type="checkbox" disabled={busy || !hasVoice} checked={spec.audio.enhanceVoice}
          onChange={(e) => void edit((s) => { s.audio.enhanceVoice = e.target.checked; }, "voice clean-up")} />
        Clean up voice
      </label>
      {hasFace ? (
        <>
          <label className="ctl">
            Smooth skin
            <input className="slider" type="range" min={0} max={1} step={0.05} value={smooth} disabled={busy}
              onChange={(e) => setSmooth(Number(e.target.value))}
              onPointerUp={() => void edit((s) => { s.retouch.skinSmooth = smooth; }, "skin smoothing")}
              onKeyUp={() => void edit((s) => { s.retouch.skinSmooth = smooth; }, "skin smoothing")} />
          </label>
          <label className="ctl">
            Face light
            <input className="slider" type="range" min={0} max={1} step={0.05} value={light} disabled={busy}
              onChange={(e) => setLight(Number(e.target.value))}
              onPointerUp={() => void edit((s) => { s.retouch.faceLight = light; }, "face light")}
              onKeyUp={() => void edit((s) => { s.retouch.faceLight = light; }, "face light")} />
          </label>
        </>
      ) : null}
      {err ? <span className="err">{err}</span> : null}
    </div>
  );
}
