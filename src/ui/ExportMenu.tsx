// Export: render the final MP4 locally, then download it or open its folder.
import { useEffect, useRef, useState } from "react";
import { api, fmtBytes, fmtTime, type Project, type RenderState } from "./api";
import { GuideNotes } from "./NightShift";
import { PublishKit } from "./PublishKit";

function Ring({ p }: { p: number }) {
  const r = 7, c = 2 * Math.PI * r;
  return (
    <svg className="ring" viewBox="0 0 18 18">
      <circle cx="9" cy="9" r={r} fill="none" stroke="rgba(42,22,0,.25)" strokeWidth="2.5" />
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 9 9)" strokeLinecap="round" />
    </svg>
  );
}

export function ExportMenu({ project, render, clearRender }: { project: Project; render: RenderState | null; clearRender: () => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const queued = render?.state === "queued"; // another render (e.g. Night Shift) is ahead in line
  const running = render?.state === "running" || queued;
  const canRender = project.spec.clips.length > 0 || project.spec.overlays.length > 0;

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  const start = async (quality: "high" | "draft") => {
    setErr(null);
    try {
      await api.render(project.id, quality);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="export-wrap" ref={wrap}>
      <button className="btn primary" onClick={() => setOpen((o) => !o)}>
        {running ? <><Ring p={render?.progress ?? 0} /> {queued ? "Queued…" : `Rendering ${Math.round((render?.progress ?? 0) * 100)}%`}</> : "Export"}
      </button>
      {open ? (
        <div className="popover">
          <div className="kicker" style={{ marginBottom: 8 }}>Render on this PC</div>
          {running ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div className="bar"><i style={{ width: `${(render?.progress ?? 0) * 100}%` }} /></div>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {queued
                  ? "Waiting in line — renders run one at a time (another export or Night Shift is rendering)."
                  : "Rendering uses most of your CPU — expect a few minutes per minute of video."}
              </span>
              <button className="btn sm danger" style={{ justifySelf: "start" }} onClick={() => void api.cancelRender(project.id)}>Cancel render</button>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <button className="btn primary" disabled={!canRender} onClick={() => void start("high")}>Render full quality MP4</button>
              <button className="btn sm" disabled={!canRender} onClick={() => void start("draft")}>Quick draft (half size, faster)</button>
              {!canRender ? <span className="muted" style={{ fontSize: 12 }}>Nothing to render yet — ask Claude to edit first.</span> : null}
            </div>
          )}
          {render?.state === "error" ? <p className="err">Render failed: {render.error}</p> : null}
          {err ? <p className="err">{err}</p> : null}
          <GuideNotes project={project} />
          <div className="kicker" style={{ margin: "16px 0 4px" }}>Your exports</div>
          {project.exports.length === 0 ? <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>None yet.</p> : null}
          {project.exports.map((e) => (
            <div key={e.file} className="export-row">
              <span className="name">{e.file}</span>
              <span className="muted mono" style={{ fontSize: 11 }}>{fmtTime(e.duration)} · {fmtBytes(e.size)} · {new Date(e.createdAt).toLocaleString()}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <a className="btn sm" href={api.fileUrl(project.id, `exports/${encodeURIComponent(e.file)}`, true)}>Download</a>
                <button className="btn sm" onClick={() => void api.reveal(project.id, e.file).catch((x: Error) => setErr(x.message))}>Show in folder</button>
                <button className="btn sm ghost danger" onClick={() => {
                  if (confirm(`Delete ${e.file}?`)) void api.deleteExport(project.id, e.file).catch((x: Error) => setErr(x.message));
                }}>Delete</button>
              </div>
            </div>
          ))}
          <PublishKit project={project} />
          <p className="dim" style={{ fontSize: 11.5, margin: "12px 0 0" }}>
            YouTube: upload the MP4 as-is. Shorts / Reels / TikTok: vertical exports under 3 minutes post directly.
          </p>
        </div>
      ) : null}
      {render?.state === "done" && render.file ? (
        <div className="toast">
          <span className="dot ok" /> Export ready
          <a className="btn sm primary" href={api.fileUrl(project.id, `exports/${encodeURIComponent(render.file)}`, true)}>Download</a>
          <button className="btn sm" onClick={() => void api.reveal(project.id, render.file!)}>Show in folder</button>
          <button className="btn sm ghost" onClick={clearRender}>×</button>
        </div>
      ) : null}
    </div>
  );
}
