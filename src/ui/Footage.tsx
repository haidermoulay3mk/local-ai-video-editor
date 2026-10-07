// Left column: your footage (upload, processing status, links) and the brief Claude works from.
import { useEffect, useRef, useState } from "react";
import { api, type Brief, type MediaRecord, type Project } from "./api";

const STEPS = ["probe", "proxy", "audio", "transcript", "silences", "faces", "look", "enhance", "fix"] as const;
const STEP_LABEL: Record<string, string> = {
  probe: "Reading file", proxy: "Making preview", audio: "Extracting audio", transcript: "Transcribing",
  silences: "Finding pauses", faces: "Tracking face", look: "Checking picture", enhance: "Cleaning voice",
  fix: "Fixing footage",
};

/** Picture verdict + one-click repair (stabilize / denoise / exposure, optional white balance). */
function LookRow({ project, m, onError }: { project: Project; m: MediaRecord; onError: (e: string) => void }) {
  const [tint, setTint] = useState(false);
  const fixing = m.steps.fix?.state === "running";
  if (m.kind !== "video") return null;
  if (m.fixed) {
    const what = (["stabilize", "denoise", "color", "whiteBalance"] as const).filter((k) => m.fixed?.[k])
      .map((k) => ({ stabilize: "stabilized", denoise: "denoised", color: "exposure fixed", whiteBalance: "tint removed" })[k]);
    return (
      <div className="look-row ok">
        <span>✓ Footage fixed: {what.join(", ")}</span>
        <button className="btn ghost sm" onClick={() => api.unfixMedia(project.id, m.id).catch((e: Error) => onError(e.message))}>Undo fix</button>
      </div>
    );
  }
  const notes = m.lookSummary?.notes ?? [];
  if (!notes.length) return m.steps.look?.state === "done" ? <div className="look-row ok"><span>✓ Picture looks good</span></div> : null;
  const canFix = m.lookSummary?.fixable || (tint && m.lookSummary?.tint);
  return (
    <div className="look-row">
      <span>Picture: {notes.join(" · ")}</span>
      {m.lookSummary?.tint ? (
        <label className="check" style={{ fontSize: 11 }}>
          <input type="checkbox" checked={tint} onChange={(e) => setTint(e.target.checked)} /> also remove the colour tint
        </label>
      ) : null}
      {canFix ? (
        <button className="btn sm" disabled={fixing} onClick={() => api.fixMedia(project.id, m.id, tint).catch((e: Error) => onError(e.message))}>
          {fixing ? "Fixing…" : "Fix footage"}
        </button>
      ) : null}
    </div>
  );
}
const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(1)}s`);

function MediaCard({ project, m, live }: { project: Project; m: MediaRecord; live?: { task: string; progress: number } }) {
  const [err, setErr] = useState<string | null>(null);
  const running = STEPS.find((s) => m.steps[s]?.state === "running");
  const failed = STEPS.filter((s) => m.steps[s]?.state === "error");
  const thumb = m.kind === "video" && m.proxy ? api.fileUrl(project.id, `media/${m.id}/${m.proxy}`) : m.kind === "image" ? api.fileUrl(project.id, `media/${m.id}/${m.original}`) : null;
  return (
    <div className="media-card">
      <div className="media-thumb">
        {thumb && m.kind === "video" ? <video src={`${thumb}#t=0.5`} muted preload="metadata" /> : thumb ? <img src={thumb} alt="" /> : <span className="mono">{m.kind === "audio" ? "AUDIO" : "…"}</span>}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="media-name" title={m.name}>{m.name}</div>
        <div className="mono dim" style={{ fontSize: 10.5 }}>
          {m.kind}{m.duration ? ` · ${fmtDur(m.duration)}` : ""}{m.width ? ` · ${m.width}×${m.height}` : ""}
          {running ? ` · ${STEP_LABEL[running]}${live && live.task === running ? ` ${Math.round(live.progress * 100)}%` : "…"}` : ""}
        </div>
        <div className="steps">
          {STEPS.filter((s) => s !== "fix" || m.steps.fix).map((s) => {
            const st = m.steps[s]?.state ?? "pending";
            const p = live && live.task === s ? live.progress : 0.3;
            return <span key={s} className={`step ${st}`} title={`${STEP_LABEL[s]}: ${st}${m.steps[s]?.error ? ` — ${m.steps[s]!.error}` : ""}`} style={{ ["--p" as string]: `${Math.round(p * 100)}%` }} />;
          })}
        </div>
        {failed.length ? <div className="err" style={{ marginTop: 4 }}>{failed.map((s) => STEP_LABEL[s]).join(", ")} failed — hover the red bars for details</div> : null}
        <LookRow project={project} m={m} onError={setErr} />
        {err ? <div className="err">{err}</div> : null}
      </div>
      <button
        className="btn ghost sm icon-btn"
        title="Remove from project"
        onClick={async () => {
          if (!confirm(`Remove “${m.name}” from this project? The copy inside the project is deleted (your original file is untouched).`)) return;
          try {
            await api.deleteMedia(project.id, m.id);
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >×</button>
    </div>
  );
}

export function Footage({ project, progress }: { project: Project; progress: Record<string, { task: string; progress: number }> }) {
  const [over, setOver] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; p: number; error?: string }[]>([]);
  const [showLink, setShowLink] = useState(false);
  const [link, setLink] = useState("");
  const [rights, setRights] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploads((u) => [...u, { name: f.name, p: 0 }]);
      try {
        await api.upload(project.id, f, (p) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, p } : x))));
        setUploads((u) => u.filter((x) => x.name !== f.name));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, error: (e as Error).message } : x)));
      }
    }
  };

  const addLink = async () => {
    setLinkBusy(true);
    setLinkErr(null);
    try {
      await api.addUrl(project.id, link.trim(), rights);
      setLink("");
      setRights(false);
      setShowLink(false);
    } catch (e) {
      setLinkErr((e as Error).message);
    } finally {
      setLinkBusy(false);
    }
  };

  return (
    <>
      <section>
        <div className="panel-h"><h3>Footage</h3><span className="kicker">{project.media.length} file{project.media.length === 1 ? "" : "s"}</span></div>
        <div
          className={`drop ${over ? "over" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files); }}
        >
          <strong>Drop your video here</strong>
          or click to choose · video, music, images · up to 8 GB
          <input ref={input} type="file" multiple hidden accept="video/*,audio/*,image/*" onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
        </div>
        {uploads.map((u) => (
          <div key={u.name} className="uploading">
            {u.error ? <span className="err">{u.name}: {u.error}</span> : <>Uploading {u.name} · {Math.round(u.p * 100)}%<div className="bar"><i style={{ width: `${u.p * 100}%` }} /></div></>}
          </div>
        ))}
        {project.media.map((m) => <MediaCard key={m.id} project={project} m={m} live={progress[m.id]} />)}
        <div style={{ marginTop: 10 }}>
          <button className="btn ghost sm" onClick={() => setShowLink((v) => !v)}>{showLink ? "Cancel" : "+ Add from a direct file link"}</button>
          {showLink ? (
            <div className="link-form">
              <input className="field" placeholder="https://…/my-video.mp4" value={link} onChange={(e) => setLink(e.target.value)} />
              <label className="check">
                <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />
                <span>I own this file or have the rights to edit and publish it.</span>
              </label>
              <span className="dim" style={{ fontSize: 11.5 }}>YouTube / Instagram / TikTok pages can't be downloaded (their rules). For your own posts, download the original from YouTube Studio or Instagram's “Download your information”, then drop the file above.</span>
              <button className="btn sm" disabled={!link.trim() || !rights || linkBusy} onClick={() => void addLink()}>{linkBusy ? "Downloading…" : "Add file"}</button>
              {linkErr ? <span className="err">{linkErr}</span> : null}
            </div>
          ) : null}
        </div>
      </section>
      <BriefPanel project={project} />
    </>
  );
}

function BriefPanel({ project }: { project: Project }) {
  const [goal, setGoal] = useState(project.brief.goal);
  const [notes, setNotes] = useState(project.brief.notes);
  const [refUrl, setRefUrl] = useState("");
  const [refNote, setRefNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setGoal(project.brief.goal);
    setNotes(project.brief.notes);
  }, [project.brief.goal, project.brief.notes]);

  const save = async (brief: Partial<Brief>) => {
    try {
      await api.patch(project.id, { brief });
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const addRef = () => {
    try {
      new URL(refUrl);
    } catch {
      setErr("That doesn't look like a link.");
      return;
    }
    void save({ references: [...project.brief.references, { url: refUrl.trim(), note: refNote.trim() }] });
    setRefUrl("");
    setRefNote("");
  };

  return (
    <section>
      <div className="panel-h"><h3>Brief</h3><span className="kicker">Claude reads this</span></div>
      <div style={{ display: "grid", gap: 10 }}>
        <div>
          <label className="lbl">What's this video for?</label>
          <textarea className="field" rows={2} placeholder="e.g. a 45-second reel teaching one gym tip, energetic" value={goal}
            onChange={(e) => setGoal(e.target.value)} onBlur={() => goal !== project.brief.goal && void save({ goal })} />
        </div>
        <div>
          <label className="lbl">Anything Claude should know</label>
          <textarea className="field" rows={2} placeholder="Names & spellings, brand colours, words to emphasise, things to avoid" value={notes}
            onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== project.brief.notes && void save({ notes })} />
        </div>
        <div>
          <label className="lbl">Style references (never downloaded)</label>
          {project.brief.references.map((r, i) => (
            <div key={`${r.url}${i}`} className="ref" style={{ marginBottom: 6 }}>
              <a href={r.url} target="_blank" rel="noreferrer noopener">{r.url}</a>
              <span className="muted">{r.note || "no description"}</span>
              <button className="btn ghost sm" style={{ justifySelf: "start", padding: 0, height: 20 }}
                onClick={() => void save({ references: project.brief.references.filter((_, j) => j !== i) })}>remove</button>
            </div>
          ))}
          <div style={{ display: "grid", gap: 6 }}>
            <input className="field" placeholder="Link to a video whose style you like" value={refUrl} onChange={(e) => setRefUrl(e.target.value)} />
            <input className="field" placeholder="What do you like about it? (captions, colours, pacing…)" value={refNote} onChange={(e) => setRefNote(e.target.value)} />
            <button className="btn sm" disabled={!refUrl.trim()} onClick={addRef} style={{ justifySelf: "start" }}>Add reference</button>
          </div>
          <p className="dim" style={{ fontSize: 11.5, margin: "6px 0 0" }}>Claude can't watch other people's videos — your description is what it uses to recreate the look with your own footage.</p>
        </div>
        {err ? <span className="err">{err}</span> : null}
      </div>
    </section>
  );
}
