// One video element, two decoders: Remotion's classic OffthreadVideo (ffmpeg in a side process)
// or the WebCodecs-based <Video> from @remotion/media (decodes inside Chrome; falls back to
// OffthreadVideo by itself if a file can't be decoded). Chosen per render via CompositionProps.videoEngine.
import type React from "react";
import type { CSSProperties } from "react";
import { createContext, useContext } from "react";
import { OffthreadVideo } from "remotion";
import { Video as WebCodecsVideo } from "@remotion/media";

export type VideoEngine = "offthread" | "webcodecs";
export const VideoEngineContext = createContext<VideoEngine>("offthread");

type Props = {
  src: string;
  trimBefore?: number;
  trimAfter?: number;
  playbackRate?: number;
  muted?: boolean;
  volume?: number;
  style?: CSSProperties;
};

export const VideoTag: React.FC<Props> = (p) => {
  const engine = useContext(VideoEngineContext);
  if (engine === "webcodecs") {
    // This decoder paints into a canvas, so CSS object-fit is ignored — it has its own prop.
    const fit = (p.style?.objectFit ?? "fill") as "fill" | "contain" | "cover" | "none" | "scale-down";
    return (
      <WebCodecsVideo
        src={p.src}
        trimBefore={p.trimBefore}
        trimAfter={p.trimAfter}
        playbackRate={p.playbackRate ?? 1}
        muted={p.muted ?? false}
        volume={p.volume ?? 1}
        objectFit={fit}
        style={p.style}
      />
    );
  }
  return (
    <OffthreadVideo
      src={p.src}
      trimBefore={p.trimBefore}
      trimAfter={p.trimAfter}
      playbackRate={p.playbackRate ?? 1}
      muted={p.muted ?? false}
      volume={p.volume ?? 1}
      pauseWhenBuffering
      style={p.style}
    />
  );
};
