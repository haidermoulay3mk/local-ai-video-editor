// Film-strip overview of the edit. Click anywhere to jump the preview there.
import { useMemo, useRef } from "react";
import type { CompositionProps } from "../shared/spec";
import { layoutClips, mapWords, paginateWords, totalSeconds } from "../shared/timeline";

const label = (o: CompositionProps["spec"]["overlays"][number]) => {
  switch (o.type) {
    case "text": return o.text;
    case "template": return `${o.template}${o.props.title ? ` · ${o.props.title}` : o.props.text ? ` · ${o.props.text}` : ""}`;
    case "shape": return o.shape;
    default: return o.type;
  }
};

type Overlay = CompositionProps["spec"]["overlays"][number];

/** Greedy row packing so overlapping graphics (e.g. a full-length progress bar) never hide each other. */
function graphicRows(overlays: Overlay[]): Overlay[][] {
  const rows: Overlay[][] = [];
  for (const o of [...overlays].sort((a, b) => a.start - b.start)) {
    const row = rows.find((r) => r[r.length - 1]!.end <= o.start + 1e-6);
    if (row) row.push(o);
    else if (rows.length < 4) rows.push([o]);
    else rows[rows.length - 1]!.push(o); // cap the strip height; extra overlaps share the last row
  }
  return rows.length ? rows : [[]];
}

export function Timeline({ props, frame, onSeek }: { props: CompositionProps | null; frame: number; onSeek: (frame: number) => void }) {
  const inner = useRef<HTMLDivElement>(null);
  const data = useMemo(() => {
    if (!props) return null;
    const { spec } = props;
    const total = Math.max(0.1, totalSeconds(spec));
    const pages = spec.captions.enabled ? paginateWords(mapWords(spec, props.analysis), spec.captions.maxWordsPerPage) : [];
    return { spec, total, layouts: layoutClips(spec), pages };
  }, [props]);

  if (!data || (!data.spec.clips.length && !data.spec.overlays.length)) {
    return <div className="timeline"><div className="tl-empty mono">TIMELINE · empty — the cut will show up here as Claude builds it</div></div>;
  }
  const { spec, total, layouts, pages } = data;
  const fps = spec.format.fps;
  const pct = (t: number) => `${(Math.max(0, Math.min(total, t)) / total) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, b - a) / total) * 100}%`;
  const step = total > 300 ? 60 : total > 120 ? 30 : total > 40 ? 10 : total > 15 ? 5 : 1;
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);

  const seek = (e: React.MouseEvent) => {
    const r = inner.current!.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * total;
    onSeek(Math.max(0, Math.min(Math.round(t * fps), Math.round(total * fps) - 1)));
  };
  const minWidth = Math.max(100, total * 9); // stays readable on long videos (scrolls)

  return (
    <div className="timeline">
      <div className="tl-scroll">
        <div className="tl-inner" ref={inner} onClick={seek} style={{ minWidth }}>
          <div className="ruler">
            {ticks.map((t) => (
              <span key={t} style={{ left: pct(t) }}>{t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}` : `${t}s`}</span>
            ))}
          </div>
          <div className="lane cuts" title="Cuts">
            {layouts.map((l) => (
              <div key={l.clip.id + l.index} className="blk" style={{ left: pct(l.start), width: width(l.start, l.end) }}
                title={`${l.clip.id}: source ${l.clip.in.toFixed(2)}–${l.clip.out.toFixed(2)}s${l.clip.speed !== 1 ? ` @${l.clip.speed}x` : ""}`}>
                {l.clip.speed !== 1 ? `${l.clip.speed}×` : ""}
              </div>
            ))}
            {layouts.filter((l) => l.transitionFrames > 0).map((l) => (
              <div key={`t${l.index}`} className="trans" style={{ left: pct(l.start + l.transitionFrames / fps / 2) }} title={l.clip.transition?.type} />
            ))}
          </div>
          {graphicRows(spec.overlays).map((row, r) => (
            <div key={r} className="lane" title="Graphics">
              {row.map((o) => (
                <div key={o.id} className={`blk ov ${o.type}`} style={{ left: pct(o.start), width: width(o.start, o.end) }} title={label(o)}>
                  {label(o)}
                </div>
              ))}
            </div>
          ))}
          {pages.length ? (
            <div className="lane" title="Captions">
              {pages.map((pg, i) => (
                <div key={i} className="blk cap" style={{ left: pct(pg.start), width: width(pg.start, pg.end) }}>
                  {pg.words.map((w) => w.text).join(" ")}
                </div>
              ))}
            </div>
          ) : null}
          {spec.effects.length || spec.audio.sfx.length ? (
            <div className="lane" title="Effects & sound effects">
              {spec.effects.map((e) => (
                <div key={e.id} className="blk fx" style={{ left: pct(e.start), width: width(e.start, e.end) }} title={e.type}>{e.type}</div>
              ))}
              {spec.audio.sfx.map((s) => <div key={s.id} className="tick" style={{ left: pct(s.at) }} title={s.sound} />)}
            </div>
          ) : null}
          {spec.audio.music.length ? (
            <div className="lane" title="Music">
              {spec.audio.music.map((m) => (
                <div key={m.id} className="blk mus" style={{ left: pct(m.start), width: width(m.start, m.end ?? total) }}>music</div>
              ))}
            </div>
          ) : null}
          <div className="playhead" style={{ left: pct(frame / fps) }} />
        </div>
      </div>
    </div>
  );
}
