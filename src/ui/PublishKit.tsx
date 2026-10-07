// Publish kit (inside the Export menu): the upload text Claude wrote, subtitle files and thumbnails.
import { useEffect, useState } from "react";
import { api, type Project, type PublishState } from "./api";

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

export function PublishKit({ project }: { project: Project }) {
  const [st, setSt] = useState<PublishState | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => void api.publish(project.id).then(setSt).catch((e: Error) => setErr(e.message));
  useEffect(load, [project.id, project.publish?.updatedAt, project.thumbnails?.length]);
  if (!st) return null;

  const make = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.makeThumbnails(project.id, text.trim() || st.info?.title.split(/\s+/).slice(0, 4).join(" ") || project.name);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="publish-kit">
      <div className="kicker" style={{ margin: "16px 0 6px" }}>Publish kit</div>
      {st.info ? (
        <div className="pk-block">
          <div className="pk-row"><b className="pk-title">{st.info.title}</b><Copy text={st.info.title} label="Copy title" /></div>
          <pre className="pk-desc">{st.text}</pre>
          <div className="pk-row">
            <Copy text={st.text ?? ""} label="Copy description" />
            {st.info.pinnedComment ? <Copy text={st.info.pinnedComment} label="Copy pinned comment" /> : null}
          </div>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>No title or description yet — ask Claude: “write the title, description and hashtags”.</p>
      )}
      <div className="pk-row">
        {st.subtitleLines ? (
          <>
            <a className="btn sm" href={api.subtitlesUrl(project.id, "srt")}>Subtitles .srt</a>
            <a className="btn sm" href={api.subtitlesUrl(project.id, "vtt")}>.vtt</a>
            <span className="muted" style={{ fontSize: 11.5 }}>{st.subtitleLines} lines · upload to YouTube for searchable captions</span>
          </>
        ) : <span className="muted" style={{ fontSize: 11.5 }}>Subtitles appear once something is spoken in the edit.</span>}
      </div>
      <div className="pk-row" style={{ marginTop: 10 }}>
        <input className="field" style={{ flex: 1 }} maxLength={60} placeholder="Thumbnail text — 2-5 words, e.g. “I QUIT”" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn sm primary" disabled={busy || !project.spec.clips.length} onClick={() => void make()}>{busy ? "Making…" : "Make thumbnails"}</button>
      </div>
      {st.thumbnails.length ? (
        <div className="pk-thumbs">
          {st.thumbnails.slice(0, 6).map((t) => (
            <figure key={t.file}>
              <img src={api.fileUrl(project.id, `thumbnails/${t.file}`)} alt={t.text} loading="lazy" />
              <figcaption>
                <a className="btn sm" href={api.fileUrl(project.id, `thumbnails/${t.file}`, true)}>Download</a>
                <button className="btn sm ghost danger" onClick={() => void api.deleteThumbnail(project.id, t.file).then(load)}>×</button>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}
