// Music (fades, looping, automatic ducking under speech) and sound effects.
import type React from "react";
import { useMemo } from "react";
import { Audio, Sequence } from "remotion";
import { type CompositionProps, SFX_NAMES } from "../shared/spec";
import { mapWords, speechIntervals, totalSeconds } from "../shared/timeline";

const ATTACK = 0.15; // seconds to duck down before speech
const RELEASE = 0.5; // seconds to come back up after speech

export function duckFactor(intervals: [number, number][], t: number, duckTo: number): number {
  if (duckTo >= 1 || !intervals.length) return 1;
  let factor = 1;
  for (const [s, e] of intervals) {
    if (t >= s && t <= e) return duckTo;
    if (t < s && s - t < ATTACK) factor = Math.min(factor, duckTo + (1 - duckTo) * ((s - t) / ATTACK));
    if (t > e && t - e < RELEASE) factor = Math.min(factor, duckTo + (1 - duckTo) * ((t - e) / RELEASE));
  }
  return factor;
}

export const AudioLayer: React.FC<{ props: CompositionProps }> = ({ props }) => {
  const { spec, media, analysis, sfxBaseUrl } = props;
  const fps = spec.format.fps;
  const total = totalSeconds(spec);
  const speech = useMemo(() => speechIntervals(mapWords(spec, analysis, false)), [spec, analysis]);
  const nodes: React.ReactNode[] = [];

  for (const v of spec.audio.voice) {
    const m = media[v.mediaId];
    if (!m) continue;
    const len = Math.min((v.end ?? v.start + m.duration - v.offset) - v.start, m.duration - v.offset);
    if (len <= 0) continue;
    nodes.push(
      <Sequence key={`voice-${v.id}`} from={Math.round(v.start * fps)} durationInFrames={Math.max(1, Math.round(len * fps))} layout="none">
        <Audio src={m.enhancedSrc ?? m.src} trimBefore={Math.round(v.offset * fps)} volume={v.volume * spec.audio.voiceVolume} />
      </Sequence>,
    );
  }

  for (const mu of spec.audio.music) {
    const m = media[mu.mediaId];
    if (!m) continue;
    // Guide tracks are only for timing the edit in the preview — never rendered into an export.
    if (mu.guide && !props.preview) continue;
    const start = mu.start;
    const end = Math.min(mu.end ?? total, total);
    if (end <= start) continue;
    const srcLen = Math.max(0.1, m.duration - mu.offset);
    const iterations = mu.loop ? Math.ceil((end - start) / srcLen) : 1;
    for (let i = 0; i < iterations; i++) {
      const segStart = start + i * srcLen;
      const segLen = Math.min(srcLen, end - segStart);
      if (segLen <= 0) break;
      nodes.push(
        <Sequence key={`${mu.id}-${i}`} from={Math.round(segStart * fps)} durationInFrames={Math.max(1, Math.round(segLen * fps))} layout="none">
          <Audio
            src={m.src}
            trimBefore={Math.round(mu.offset * fps)}
            volume={(f) => {
              const t = segStart + f / fps;
              const fadeIn = mu.fadeIn > 0 ? Math.min(1, (t - start) / mu.fadeIn) : 1;
              const fadeOut = mu.fadeOut > 0 ? Math.min(1, (end - t) / mu.fadeOut) : 1;
              return Math.max(0, mu.volume * Math.min(fadeIn, fadeOut) * duckFactor(speech, t, mu.duckTo));
            }}
          />
        </Sequence>,
      );
    }
  }

  for (const s of spec.audio.sfx) {
    const builtIn = (SFX_NAMES as readonly string[]).includes(s.sound);
    const m = builtIn ? undefined : media[s.sound];
    const src = builtIn ? `${sfxBaseUrl}/${s.sound}.wav` : m?.src;
    if (!src) continue;
    const len = m ? m.duration : 3;
    nodes.push(
      <Sequence key={s.id} from={Math.round(s.at * fps)} durationInFrames={Math.max(1, Math.round(len * fps))} layout="none">
        <Audio src={src} volume={s.volume} />
      </Sequence>,
    );
  }
  return <>{nodes}</>;
};
