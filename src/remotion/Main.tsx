// Top-level composition: main video (+effects, grade) -> overlays -> captions -> top overlays -> audio.
import type React from "react";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { AbsoluteFill, Img, Loop, useCurrentFrame } from "remotion";
import type { CompositionProps, MediaInfo } from "../shared/spec";
import { layoutClips } from "../shared/timeline";
import { AudioLayer } from "./AudioLayer";
import { Captions } from "./Captions";
import { fontsUsed, sampleText, useFontsReady } from "./fonts";
import { effectsAt, GradeOverlays, gradeFilter, RgbSplitFilter } from "./Look";
import { faceOnCanvas, MainVideo, mediaSrc } from "./MainVideo";
import { OverlayStack } from "./Overlays";
import { VideoEngineContext, VideoTag } from "./VideoTag";

export const TOP_LAYER_Z = 100; // overlays with z >= 100 render above captions

/** Split-screen filler: cover-fits a video (looped from layout.in) or a photo into its band. */
const Filler: React.FC<{ props: CompositionProps; m: MediaInfo; width: number; height: number }> = ({ props, m, width, height }) => {
  const { fps } = props.spec.format;
  const s = Math.max(width / Math.max(1, m.width), height / Math.max(1, m.height));
  const w = m.width * s, h = m.height * s;
  const style: CSSProperties = { position: "absolute", left: (width - w) / 2, top: (height - h) / 2, width: w, height: h, maxWidth: "none", objectFit: "fill" };
  const src = mediaSrc(m, props.preview);
  if (m.kind === "image") return <Img src={src} style={style} />;
  if (m.kind !== "video") return null;
  const start = Math.min(props.spec.layout.in, Math.max(0, m.duration - 1));
  const loop = Math.max(1, Math.floor((m.duration - start) * fps));
  const vol = props.spec.layout.fillerVolume;
  return (
    <Loop durationInFrames={loop}>
      <VideoTag src={src} trimBefore={Math.round(start * fps)} trimAfter={Math.round(start * fps) + loop} muted={vol === 0} volume={vol} style={style} />
    </Loop>
  );
};

export const Main: React.FC<CompositionProps> = (props) => {
  const { spec, analysis } = props;
  const frame = useCurrentFrame();
  const { width: W, height: H, fps } = spec.format;
  const layouts = useMemo(() => layoutClips(spec), [spec]);
  const transcriptSample = useMemo(
    () => Object.values(analysis).flatMap((a) => (a.words ?? []).slice(0, 200).map((w) => w.text)).join(" "),
    [analysis],
  );
  useFontsReady(fontsUsed(spec), sampleText(spec, transcriptSample));

  // Split screen: the clips get a band of the frame (as if the canvas were that size), a looping filler the rest.
  const layout = spec.layout;
  const filler = layout.mode === "split" && layout.mediaId ? props.media[layout.mediaId] : undefined;
  const mainH = filler ? Math.round(H * layout.ratio) : H;
  const mainTop = filler && layout.fillerPosition === "top" ? H - mainH : 0;
  const mainProps = useMemo(
    () => (mainH === H ? props : { ...props, spec: { ...spec, format: { ...spec.format, height: mainH } } }),
    [props, spec, mainH, H],
  );

  const t = frame / fps;
  const local = faceOnCanvas(mainProps, layouts, t);
  const face = local && mainTop ? { ...local, y: local.y + mainTop } : local;
  const fx = effectsAt(spec.effects, t, fps, W, mainH, local);
  const filter = [gradeFilter(spec), fx.filter, fx.rgbSplit > 0 ? "url(#ve-rgbsplit)" : ""].join(" ").trim();
  const below = spec.overlays.filter((o) => o.z < TOP_LAYER_Z);
  const above = spec.overlays.filter((o) => o.z >= TOP_LAYER_Z);

  return (
    <VideoEngineContext.Provider value={props.videoEngine ?? "offthread"}>
    <AbsoluteFill style={{ background: spec.background, overflow: "hidden" }}>
      {fx.rgbSplit > 0 ? <RgbSplitFilter id="ve-rgbsplit" offset={fx.rgbSplit} /> : null}
      <div style={{ position: "absolute", left: 0, top: mainTop, width: W, height: mainH, overflow: "hidden" }}>
        <AbsoluteFill style={{ transform: fx.transform || undefined, transformOrigin: fx.origin }}>
          <AbsoluteFill style={{ filter }}>
            <MainVideo props={mainProps} />
          </AbsoluteFill>
        </AbsoluteFill>
      </div>
      {filler ? (
        <div style={{ position: "absolute", left: 0, top: mainTop ? 0 : mainH, width: W, height: H - mainH, overflow: "hidden", filter: gradeFilter(spec) || undefined }}>
          <Filler props={props} m={filler} width={W} height={H - mainH} />
        </div>
      ) : null}
      {filler && layout.divider ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: (mainTop ? mainTop : mainH) - 3, height: 6, background: layout.divider }} />
      ) : null}
      <GradeOverlays spec={spec} face={face} />
      {fx.flash > 0 ? <AbsoluteFill style={{ background: "#fff", opacity: fx.flash }} /> : null}
      <OverlayStack props={props} overlays={below} />
      <Captions props={props} />
      <OverlayStack props={props} overlays={above} />
      <AudioLayer props={props} />
    </AbsoluteFill>
    </VideoEngineContext.Provider>
  );
};
