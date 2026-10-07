// The editing room: footage + brief | monitor + timeline | director (Claude).
import type { PlayerRef } from "@remotion/player";
import { useCallback, useEffect, useRef, useState } from "react";
import { FORMAT_PRESETS } from "../shared/spec";
import { api, type Brief, useProject } from "./api";
import { go } from "./App";
import { Director } from "./Director";
import { ExportMenu } from "./ExportMenu";
import { Footage } from "./Footage";
import { Monitor } from "./Monitor";
import { HookIdeas } from "./NightShift";
import { Timeline } from "./Timeline";

const FORMAT_LABEL: Record<Brief["platform"], string> = { short: "9:16 Short", youtube: "16:9 YouTube", portrait: "4:5 Feed", square: "1:1 Square" };

export function Editor({ id }: { id: string }) {
  const { project, props, progress, render, setRender, usage, error } = useProject(id);
  const playerRef = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (project) setName(project.name);
  }, [project?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((f: number) => {
    playerRef.current?.seekTo(f);
    setFrame(f);
  }, []);

  if (error && !project) {
    return (
      <div className="home">
        <h1 className="section-title">Couldn't open this project</h1>
        <p className="err">{error}</p>
        <button className="btn" onClick={() => go(null)}>← All projects</button>
      </div>
    );
  }
  if (!project) return <div className="home"><span className="thinking"><i /><i /><i /> Opening…</span></div>;

  const setFormat = async (platform: Brief["platform"]) => {
    if (platform === project.brief.platform) return;
    const spec = structuredClone(project.spec);
    spec.format = { ...spec.format, preset: platform, ...FORMAT_PRESETS[platform] };
    const r = await api.putSpec(project.id, spec, `format → ${platform}`);
    if (!r.ok) return setMsg(r.errors.join(" · "));
    await api.patch(project.id, { brief: { platform } });
    setMsg(null);
  };

  return (
    <div className="editor">
      <header className="topbar">
        <span className="logo" title="All projects" onClick={() => go(null)}>Video Editor</span>
        <input
          className="title-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== project.name && void api.patch(project.id, { name })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <div className="seg" role="group" aria-label="Format">
          {(Object.keys(FORMAT_LABEL) as Brief["platform"][]).map((f) => (
            <button key={f} className={project.brief.platform === f ? "on" : ""} onClick={() => void setFormat(f)}>{FORMAT_LABEL[f]}</button>
          ))}
        </div>
        <button className="btn sm ghost" title="Undo the last change to the edit" onClick={() => void api.undo(project.id)}>↶ Undo</button>
        {msg ? <span className="err">{msg}</span> : null}
        <span className="spacer" />
        <ExportMenu project={project} render={render} clearRender={() => setRender(null)} />
      </header>
      <div className="workspace">
        <aside className="col col-left">
          <Footage project={project} progress={progress} />
          {project.hooks?.length ? (
            <section>
              <div className="panel-h"><h3>Hook ideas</h3><span className="muted mono" style={{ fontSize: 11 }}>{project.hooks.length}</span></div>
              <HookIdeas project={project} compact onError={setMsg} />
            </section>
          ) : null}
        </aside>
        <main className="col col-mid">
          <Monitor project={project} props={props} playerRef={playerRef} frame={frame} setFrame={setFrame} />
          <Timeline props={props} frame={frame} onSeek={seek} />
        </main>
        <aside className="col col-right">
          <Director project={project} usage={usage} />
        </aside>
      </div>
    </div>
  );
}
