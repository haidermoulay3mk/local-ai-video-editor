// Night Shift: plan tonight's batch, watch it work, and review the "dailies" in the morning —
// finished videos plus ranked hook ideas, each with a short preview, waiting for a decision.
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import {
  api, fmtBytes, fmtTime, music, night, type NightBatch, type NightOverview, type NightSettings, type Project, type StoredHook, useNightLive,
  useProject,
} from "./api";
import { go, goNight } from "./App";

type Item = NightBatch["items"][number];

const FORMATS: { id: NightSettings["format"]; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "short", label: "9:16 Short / Reel" },
  { id: "youtube", label: "16:9 YouTube" },
  { id: "portrait", label: "4:5 Feed" },
  { id: "square", label: "1:1 Square" },
];
const MODES: { id: NightSettings["mode"]; title: string; sub: string }[] = [
  { id: "separate", title: "One video per clip", sub: "Each clip becomes its own finished video." },
  { id: "combine", title: "One video from all clips", sub: "Every clip edited together into one story." },
  { id: "clips", title: "Long video → shorts", sub: "Finds the best moments of each long video and makes a short from each." },
  { id: "longform", title: "Long-form video", sub: "A YouTube video from your clips and/or a script — voiceover, music, chapters." },
];
const MODELS: { id: NightSettings["model"]; label: string }[] = [
  { id: "sonnet", label: "Sonnet — strong edits, light on your usage (recommended)" },
  { id: "opus", label: "Opus — best taste, uses a lot more of your plan" },
  { id: "haiku", label: "Haiku — quickest, simpler edits" },
];
const PATTERN: Record<StoredHook["pattern"], string> = {
  cold_open: "Cold open", bold_claim: "Bold claim", question: "Question", contrarian: "Contrarian",
  pattern_interrupt: "Pattern interrupt", list_promise: "List promise", result_first: "Result first",
  story_stakes: "Story stakes", other: "Hook",
};
const STATE: Record<NightBatch["state"], { label: string; dot: string }> = {
  draft: { label: "Not started", dot: "" },
  scheduled: { label: "Scheduled", dot: "amber" },
  queued: { label: "Queued", dot: "amber" },
  running: { label: "On shift", dot: "live" },
  waiting_limit: { label: "Waiting for Claude", dot: "amber" },
  done: { label: "Finished", dot: "ok" },
  cancelled: { label: "Cancelled", dot: "" },
};
const LIVE = new Set<NightBatch["state"]>(["scheduled", "queued", "running", "waiting_limit"]);
const BUSY = new Set<Item["state"]>(["ingesting", "editing", "rendering"]);
const EDIT_BY: Record<NonNullable<Item["edit"]>, string> = { claude: "Edited by Claude", partial: "Claude (partly)", fallback: "Automatic edit" };

/** Claude writes **bold** in its summaries — show it as bold instead of asterisks. */
const boldMarkdown = (t: string) =>
  t.split(/(\*\*[^*\n]+\*\*)/g).map((s, i) => (s.length > 4 && s.startsWith("**") && s.endsWith("**") ? <b key={i}>{s.slice(2, -2)}</b> : s));

const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function NightShift({ id }: { id: string | null }) {
  return (
    <div className="home night">
      <nav className="crumbs">
        <span className="logo" title="All projects" onClick={() => go(null)}>Video Editor</span>
        <span className="dim">/</span>
        <a href="#/night" className="crumb">Night Shift</a>
      </nav>
      {id ? <Shift key={id} id={id} /> : <ShiftList />}
    </div>
  );
}

// ---------------------------------------------------------------- list

function ShiftList() {
  const [ov, setOv] = useState<NightOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => void night.overview().then(setOv).catch((e: Error) => setErr(e.message)), []);
  useEffect(load, [load]);
  useNightLive(load);

  const create = async () => {
    try {
      goNight((await night.create()).id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <header className="night-hero">
        <div>
          <div className="kicker">Autonomous mode · works while you sleep</div>
          <h1 className="brand">Night <em>Shift</em></h1>
          <p className="tagline">
            Give it tonight's clips and go to bed. Claude edits every video on its own, exports it, and leaves you ranked hook
            ideas — each with a preview — to choose from in the morning.
          </p>
          <button className="btn primary lg" onClick={() => void create()}>Plan tonight's shift</button>
          {err ? <p className="err">{err}</p> : null}
        </div>
        <ol className="night-steps">
          <li><span><b>Add clips</b> — drop them in, or put them in your inbox folder.</span></li>
          <li><span><b>Choose a format</b> — or leave it on Auto: under 3 minutes becomes a Short/Reel, longer becomes YouTube.</span></li>
          <li><span><b>Start</b> — now, or at a set time. Leave the PC on and plugged in.</span></li>
          <li><span><b>In the morning</b> — watch the dailies, tap “Use this hook”, download.</span></li>
        </ol>
      </header>

      {ov?.batches.length ? (
        <section className="home-block">
          <h2 className="section-title">Your shifts</h2>
          <div className="recent">
            {ov.batches.map((b) => {
              const ready = b.items.filter((i) => i.state === "done");
              const hooks = ready.reduce((s, i) => s + (i.hooks ?? 0), 0);
              return (
                <div key={b.id} className="recent-card" onClick={() => goNight(b.id)}>
                  <div style={{ minWidth: 0 }}>
                    <h4>{b.name}</h4>
                    <span className="muted mono" style={{ fontSize: 11 }}>
                      <span className={`dot ${STATE[b.state].dot}`} style={{ display: "inline-block", marginRight: 6 }} />
                      {STATE[b.state].label} · {b.items.length ? `${ready.length}/${b.items.length} ready` : plural(b.files.length, "clip")}
                      {hooks ? ` · ${plural(hooks, "hook")}` : ""}
                    </span>
                  </div>
                  {!LIVE.has(b.state) ? (
                    <button
                      className="btn ghost sm icon-btn danger"
                      title="Delete this shift (its finished videos stay in your projects)"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Delete “${b.name}”? Finished videos stay in your projects; clips that were never edited are removed.`)) return;
                        await night.remove(b.id).catch((x: Error) => setErr(x.message));
                        load();
                      }}
                    >×</button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- one shift

function Shift({ id }: { id: string }) {
  const [b, setB] = useState<NightBatch | null>(null);
  const [ov, setOv] = useState<NightOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    void night.get(id).then(setB).catch((e: Error) => setErr(e.message));
    void night.overview().then(setOv).catch(() => {});
  }, [id]);
  useEffect(load, [load]);
  useNightLive(load);

  if (!b) return err ? <p className="err" style={{ maxWidth: 1200, margin: "0 auto" }}>{err}</p> : <span className="thinking"><i /><i /><i /> Opening…</span>;
  const reviewable = b.items.filter((i) => i.kind !== "scout" && i.projectId && (i.state === "done" || (i.state === "error" && i.exportFile)));

  return (
    <>
      <ShiftHead b={b} setB={setB} onError={setErr} />
      {err ? <p className="err" style={{ maxWidth: 1200, margin: "12px auto 0" }}>{err}</p> : null}
      {b.state === "draft" ? <Setup b={b} ov={ov} setB={setB} onError={setErr} /> : null}
      {b.items.length ? (
        <section className="home-block">
          <h2 className="section-title">Tonight's videos</h2>
          <div className="reel">{b.items.map((it, i) => <ReelRow key={it.id} item={it} n={i + 1} />)}</div>
        </section>
      ) : null}
      {reviewable.length ? (
        <section className="home-block" id="dailies">
          <h2 className="section-title">Morning dailies</h2>
          <p className="muted" style={{ margin: "-8px 0 0", fontSize: 13.5 }}>
            Each video is finished as it is. Pick a hook to put at the very start — the final video re-renders with it, ready to download.
          </p>
          {reviewable.map((it) => <Daily key={it.id} item={it} />)}
        </section>
      ) : null}
      {b.log.length ? (
        <details className="shift-log">
          <summary>Shift log</summary>
          {[...b.log].reverse().map((l, i) => (
            <div key={`${l.at}-${i}`}><span className="mono dim">{clock(l.at)}</span><span>{l.text}</span></div>
          ))}
        </details>
      ) : null}
    </>
  );
}

function ShiftHead({ b, setB, onError }: { b: NightBatch; setB: (b: NightBatch) => void; onError: (e: string | null) => void }) {
  const [name, setName] = useState(b.name);
  useEffect(() => setName(b.name), [b.name]);
  const done = b.items.filter((i) => i.state === "done").length;
  const act = (p: Promise<NightBatch>) => void p.then(setB).catch((e: Error) => onError(e.message));
  const last = b.log[b.log.length - 1]?.text;

  return (
    <>
      <header className="shift-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <span className="pill"><span className={`dot ${STATE[b.state].dot}`} />{STATE[b.state].label}</span>
          {b.state === "draft" ? (
            <input
              className="title-input shift-title"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name !== b.name && act(night.patch(b.id, { name }))}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <h1>{b.name}</h1>
          )}
        </div>
      </header>
      {b.state === "scheduled" ? (
        <div className="banner">
          Starts at <span className="clock">{clock(b.settings.startAt)}</span>
          <span className="muted">Leave the Video Editor open and the PC plugged in{b.settings.keepAwake ? " — it won't go to sleep." : "."}</span>
          <span className="spacer" />
          <button className="btn sm danger" onClick={() => act(night.cancel(b.id))}>Cancel</button>
        </div>
      ) : null}
      {b.state === "queued" ? (
        <div className="banner">
          <span className="thinking"><i /><i /><i /></span> Starting — or waiting for another shift to finish.
          <span className="spacer" />
          <button className="btn sm danger" onClick={() => act(night.cancel(b.id))}>Cancel</button>
        </div>
      ) : null}
      {b.state === "running" || b.state === "waiting_limit" ? (
        <div className="banner">
          {b.state === "running" ? (
            <><span className="dot live" /> On shift — {done} of {plural(b.items.length, "video")} ready.</>
          ) : (
            <>Claude's usage limit was reached. Continuing at <span className="clock">{clock(b.resumeAt)}</span></>
          )}
          <span className="muted">You can close this tab; keep the Video Editor running.</span>
          <span className="spacer" />
          <button className="btn sm danger" onClick={() => confirm("Stop the night shift? Finished videos are kept.") && act(night.cancel(b.id))}>Stop the shift</button>
        </div>
      ) : null}
      {(b.state === "done" || b.state === "cancelled") && last ? (
        <div className="banner">
          <span className={`dot ${b.state === "done" ? "ok" : ""}`} /> {last}
          {b.finishedAt ? <span className="muted mono" style={{ fontSize: 11.5 }}>{new Date(b.finishedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span> : null}
          <span className="spacer" />
          <button className="btn sm" onClick={() => void night.create().then((n) => goNight(n.id)).catch((e: Error) => onError(e.message))}>Plan another shift</button>
        </div>
      ) : null}
    </>
  );
}

function defaultStartTime() {
  const h = new Date().getHours();
  return h >= 20 || h < 5 ? `${String((h + 1) % 24).padStart(2, "0")}:00` : "23:00";
}

function Setup({ b, ov, setB, onError }: { b: NightBatch; ov: NightOverview | null; setB: (b: NightBatch) => void; onError: (e: string | null) => void }) {
  const [uploads, setUploads] = useState<{ key: string; name: string; p: number }[]>([]);
  const [over, setOver] = useState(false);
  const [notes, setNotes] = useState(b.settings.instructions);
  const [script, setScript] = useState(b.settings.script ?? "");
  const [reference, setReference] = useState(b.settings.reference ?? "");
  const [voices, setVoices] = useState<Record<string, string>>({ am_michael: "Michael — confident US male" });
  const [at, setAt] = useState(defaultStartTime);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const s = b.settings;
  useEffect(() => void music.library().then((l) => setVoices(l.voices)).catch(() => {}), []);

  const patch = (settings: Partial<NightSettings>) => void night.patch(b.id, { settings }).then(setB).catch((e: Error) => onError(e.message));

  const addFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    const queue = files.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, p: 0, f }));
    setUploads((u) => [...u, ...queue.map(({ key, name, p }) => ({ key, name, p }))]);
    for (const q of queue) {
      try {
        setB(await night.upload(b.id, q.f, (p) => setUploads((u) => u.map((x) => (x.key === q.key ? { ...x, p } : x)))));
      } catch (e) {
        onError(`${q.name}: ${(e as Error).message}`);
      } finally {
        setUploads((u) => u.filter((x) => x.key !== q.key));
      }
    }
  };

  const start = async (when?: "later") => {
    setBusy(true);
    onError(null);
    try {
      if (notes !== s.instructions || script !== (s.script ?? "") || reference !== (s.reference ?? "")) {
        await night.patch(b.id, { settings: { instructions: notes, script, reference } });
      }
      let startAt: string | undefined;
      if (when === "later") {
        const [h, m] = at.split(":").map(Number);
        const d = new Date();
        d.setHours(h ?? 23, m ?? 0, 0, 0);
        if (d.getTime() <= Date.now() + 60_000) d.setDate(d.getDate() + 1);
        startAt = d.toISOString();
      }
      setB(await night.start(b.id, startAt));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const files = b.files.filter((f) => f.size > 0);
  const scriptOnly = s.mode === "longform" && !!script.trim();
  const ready = (files.length > 0 || s.useInbox || scriptOnly) && uploads.length === 0 && !b.files.some((f) => f.size === 0);

  return (
    <section className="home-block setup">
      <div className="card">
        <h3>Tonight's clips</h3>
        <p className="sub">Videos of you, shorts, reels — each becomes its own video (or combine them below). Your originals are never changed.</p>
        <div
          className={`drop ${over ? "over" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void addFiles(e.dataTransfer.files);
          }}
        >
          <strong>Drop clips here</strong>or click to choose · mp4, mov, webm, mkv
          <input ref={input} type="file" accept="video/*,.mkv,.mov" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
        </div>
        {files.map((f) => (
          <div key={f.name} className="file-row">
            <span className="name" title={f.name}>{f.name}</span>
            <span className="muted mono" style={{ fontSize: 11 }}>{fmtBytes(f.size)}</span>
            <button className="btn ghost sm icon-btn danger" title="Remove" onClick={() => void night.removeFile(b.id, f.name).then(setB).catch((e: Error) => onError(e.message))}>×</button>
          </div>
        ))}
        {uploads.map((u) => (
          <div key={u.key} className="file-row">
            <span className="name">{u.name}</span>
            <div className="bar" style={{ width: 90, margin: 0 }}><i style={{ width: `${u.p * 100}%` }} /></div>
            <span className="muted mono" style={{ fontSize: 11 }}>{Math.round(u.p * 100)}%</span>
          </div>
        ))}
        <div className="inbox">
          <span>
            Or drop videos into your <b>inbox folder</b> any time (e.g. straight from your phone):<br />
            <code title={ov?.inbox}>{(ov?.inbox ?? "Videos\\Video Editor Inbox").split(/[\\/]/).slice(-2).join(" › ")}</code>
          </span>
          <div className="start-row">
            <button className="btn sm" onClick={() => void night.openInbox().catch((e: Error) => onError(e.message))}>Open inbox folder</button>
            <button className="btn sm" disabled={!ov?.inboxNew} onClick={() => void night.importInbox(b.id).then(setB).catch((e: Error) => onError(e.message))}>
              Add {ov?.inboxNew ? plural(ov.inboxNew, "new clip") : "new clips"} now
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={s.useInbox} onChange={(e) => patch({ useInbox: e.target.checked })} />
            Also pick up whatever is new in the inbox when the shift starts
          </label>
        </div>
      </div>

      <div className="card form">
        <div>
          <h3>How should it edit?</h3>
          <p className="sub" style={{ margin: 0 }}>Claude decides everything else on its own — cuts, captions, graphics, sound, look.</p>
        </div>
        <div>
          <label className="lbl">Format</label>
          <div className="seg wrap">
            {FORMATS.map((f) => (
              <button key={f.id} className={s.format === f.id ? "on" : ""} onClick={() => patch({ format: f.id })}>{f.label}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="lbl">What to make</label>
          <div className="mode-cards">
            {MODES.map((m) => (
              <button key={m.id} className={`mode-card ${s.mode === m.id ? "on" : ""}`} onClick={() => patch({ mode: m.id })}>
                <b>{m.title}</b>
                <span>{m.sub}</span>
              </button>
            ))}
          </div>
        </div>
        {s.mode === "clips" ? (
          <div>
            <label className="lbl" htmlFor="night-count">Shorts per long video · {s.clipCount ?? 10}</label>
            <input id="night-count" type="range" min={3} max={15} value={s.clipCount ?? 10} onChange={(e) => patch({ clipCount: Number(e.target.value) })} />
            <p className="dim" style={{ fontSize: 11.5, margin: "4px 0 0" }}>
              Use long videos you own (download your own uploads from YouTube Studio → Content → ⋮ → Download) or have permission
              to clip. Each short gets its own edit, music, captions and hook ideas.
            </p>
          </div>
        ) : null}
        {s.mode === "longform" ? (
          <>
            <div>
              <label className="lbl" htmlFor="night-script">Script for the voiceover (optional)</label>
              <textarea
                id="night-script"
                className="field"
                rows={6}
                maxLength={30000}
                placeholder="Paste what the narrator should say. Leave empty to build the video from your clips' own audio. Blank lines = new sections."
                value={script}
                onChange={(e) => setScript(e.target.value)}
                onBlur={() => script !== (s.script ?? "") && patch({ script })}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
              <div>
                <label className="lbl" htmlFor="night-ref">Style reference link (optional)</label>
                <input
                  id="night-ref"
                  className="field"
                  placeholder="https://youtube.com/watch?v=…"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  onBlur={() => reference !== (s.reference ?? "") && patch({ reference })}
                />
              </div>
              <div>
                <label className="lbl" htmlFor="night-voice">Voice</label>
                <select id="night-voice" className="field" value={s.voice ?? "am_michael"} onChange={(e) => patch({ voice: e.target.value })}>
                  {Object.entries(voices).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            <p className="dim" style={{ fontSize: 11.5, margin: "-8px 0 0" }}>
              The reference link is never downloaded — Claude only reads its title and channel and follows that style.
            </p>
          </>
        ) : null}
        <div>
          <label className="lbl">Music</label>
          <div className="start-row">
            <div className="seg">
              <button className={(s.music ?? "auto") === "auto" ? "on" : ""} onClick={() => patch({ music: "auto" })}>Claude picks from my library</button>
              <button className={s.music === "none" ? "on" : ""} onClick={() => patch({ music: "none" })}>No music</button>
            </div>
            <a href="#/music" className="btn sm ghost">Open music library →</a>
          </div>
        </div>
        <div>
          <label className="lbl" htmlFor="night-notes">Notes for Claude (optional)</label>
          <textarea
            id="night-notes"
            className="field"
            rows={3}
            maxLength={2000}
            placeholder="e.g. Fast pace, yellow captions, no music, keep it under 45 seconds, end with “follow @myhandle”."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== s.instructions && patch({ instructions: notes })}
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 14 }}>
          <div>
            <label className="lbl" htmlFor="night-model">Claude model</label>
            <select id="night-model" className="field" value={s.model} onChange={(e) => patch({ model: e.target.value as NightSettings["model"] })}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="lbl">Hook ideas</label>
            <div className="seg">
              {[3, 4, 5].map((n) => (
                <button key={n} className={s.hooks === n ? "on" : ""} onClick={() => patch({ hooks: n })}>{n}</button>
              ))}
            </div>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.keepAwake} onChange={(e) => patch({ keepAwake: e.target.checked })} />
          Keep this PC awake until the shift is done (the screen can still turn off)
        </label>
        <div className="start-box">
          <button className="btn primary lg" disabled={!ready || busy} onClick={() => void start()}>Start now</button>
          <span className="muted">or at</span>
          <input type="time" className="field" value={at} onChange={(e) => setAt(e.target.value)} />
          <button className="btn" disabled={!ready || busy} onClick={() => void start("later")}>Schedule</button>
        </div>
        <p className="dim" style={{ fontSize: 11.5, margin: 0 }}>
          Runs on your own Claude Code usage. If the plan's usage limit is reached, it waits for the reset and carries on;
          if Claude can't continue tonight, the remaining videos still get an automatic edit. Laptops: keep it plugged in with the lid open.
        </p>
      </div>
    </section>
  );
}

function ReelRow({ item, n }: { item: Item; n: number }) {
  const busy = BUSY.has(item.state);
  const dot = busy ? "amber" : item.state === "done" ? "ok" : item.state === "error" ? "live" : "";
  const status =
    item.step ??
    (item.state === "done"
      ? `Ready${item.hooks ? ` · ${plural(item.hooks, "hook idea")}` : ""}`
      : item.state === "waiting" ? "Waiting its turn" : item.state === "cancelled" ? "Cancelled" : item.state === "error" ? "Problem" : "");
  return (
    <div className={`reel-row ${busy ? "busy" : ""}`}>
      <span className="reel-n mono">{String(n).padStart(2, "0")}</span>
      <span className={`dot ${dot}`} />
      <div className="reel-main">
        <b title={item.name}>{item.name}</b>
        <span className="mono muted">{busy ? <span className="thinking" style={{ display: "inline-flex" }}><i /><i /><i /></span> : null} {status}</span>
        {item.error ? <span className="err">{item.error}</span> : null}
      </div>
      {item.edit ? <span className="pill">{EDIT_BY[item.edit]}</span> : <span />}
      {item.projectId ? <button className="btn sm ghost" onClick={() => go(item.projectId!)}>Open in editor</button> : <span />}
    </div>
  );
}

// ---------------------------------------------------------------- morning review

function Daily({ item }: { item: Item }) {
  const { project: p, render } = useProject(item.projectId!);
  const [err, setErr] = useState<string | null>(null);
  if (!p) return <div className="daily"><span className="thinking"><i /><i /><i /> Loading {item.name}…</span></div>;

  const chosen = p.hooks?.find((h) => h.appliedAt);
  const withHook = chosen ? p.exports.find((e) => e.label === `hook-${chosen.id}`) : undefined;
  const base = p.exports.find((e) => e.label === "night") ?? p.exports[p.exports.length - 1];
  const shown = withHook ?? base;
  const renderingFinal = !!chosen && !withHook && (render?.state === "running" || render?.state === "queued");
  const { width, height } = p.spec.format;
  const shape = height > width ? "v" : height === width ? "sq" : "h";
  const summary = p.night?.summary ?? (p.claude.status === "done" ? p.claude.message : undefined);

  return (
    <article className="daily">
      <div className="daily-head">
        <h3>{p.name}</h3>
        <span className="pill">{width}×{height}</span>
        {shown ? <span className="pill mono">{fmtTime(shown.duration)}</span> : null}
        {item.edit ? <span className="pill">{EDIT_BY[item.edit]}</span> : null}
        <span className="spacer" />
        <button className="btn sm" onClick={() => go(p.id)}>Open in editor</button>
      </div>
      <div className="daily-body">
        <div className={`daily-video ${shape}`}>
          {shown ? <video key={shown.file} src={api.fileUrl(p.id, `exports/${encodeURIComponent(shown.file)}`)} controls playsInline preload="metadata" /> : null}
        </div>
        <div style={{ minWidth: 0 }}>
          {summary ? <p className="notes">{boldMarkdown(summary)}</p> : null}
          <div className="start-row" style={{ marginBottom: 22 }}>
            {shown ? (
              <a className="btn primary" href={api.fileUrl(p.id, `exports/${encodeURIComponent(shown.file)}`, true)}>
                Download {withHook ? "final video (with hook)" : "video"}
              </a>
            ) : null}
            {shown ? <button className="btn" onClick={() => void api.reveal(p.id, shown.file).catch((e: Error) => setErr(e.message))}>Show in folder</button> : null}
            {renderingFinal ? (
              <span className="muted" style={{ fontSize: 12.5 }}>
                <span className="thinking" style={{ display: "inline-flex" }}><i /><i /><i /></span>{" "}
                {render?.state === "queued" ? "Final video with your hook is waiting to render…" : `Rendering the final video with your hook… ${Math.round((render?.progress ?? 0) * 100)}%`}
              </span>
            ) : null}
          </div>
          <GuideNotes project={p} />
          {p.hooks?.length ? (
            <>
              <div className="kicker" style={{ marginBottom: 10 }}>Hook ideas — ranked by Claude · pick one for the opening</div>
              <HookIdeas project={p} onError={setErr} />
            </>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>No hook ideas for this one{item.edit === "fallback" ? " — Claude wasn't available, so it got the automatic edit." : "."} Open it in the editor and ask Claude for hooks any time.</p>
          )}
          {err ? <p className="err">{err}</p> : null}
        </div>
      </div>
    </article>
  );
}

/** Hook proposals as a strip of film frames: preview, pattern, score, why, and "Use this hook". */
export function HookIdeas({ project: p, compact, onError }: { project: Project; compact?: boolean; onError?: (e: string | null) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const hooks = [...(p.hooks ?? [])].sort((a, b) => b.score - a.score);
  const { width, height } = p.spec.format;
  const cardWidth = height > width ? 210 : height === width ? 250 : 300;
  const fail = (e: unknown) => onError?.((e as Error).message);
  const missing = hooks.some((h) => h.previewState !== "done" && h.previewState !== "rendering");

  const use = async (h: StoredHook) => {
    setBusy(h.id);
    onError?.(null);
    try {
      const r = await api.useHook(p.id, h.id);
      if (!r.ok) onError?.(r.errors.join(" · "));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={compact ? "hooks-compact" : undefined}>
      <div className="hook-strip">
        {hooks.map((h, i) => (
          <article key={h.id} className={`hook-card ${h.appliedAt ? "chosen" : ""}`} style={{ "--w": `${cardWidth}px` } as CSSProperties}>
            <div className="hook-film">
              <div className="hook-frame" style={{ aspectRatio: `${width} / ${height}` }}>
                {h.preview && h.previewState === "done" ? (
                  <video
                    src={`${api.fileUrl(p.id, h.preview)}?v=${encodeURIComponent(h.createdAt)}`}
                    autoPlay={!compact}
                    muted
                    loop
                    playsInline
                    controls
                    preload="metadata"
                  />
                ) : (
                  <span className="hook-wait">
                    {h.previewState === "rendering" ? "Rendering preview…" : h.previewState === "error" ? "Preview failed" : "No preview yet"}
                  </span>
                )}
                <span className="hook-rank mono">#{i + 1}</span>
              </div>
            </div>
            <div className="hook-body">
              <div className="hook-meta">
                <span className="pill">{PATTERN[h.pattern]}</span>
                <span className="hook-score"><b>{h.score}</b>/10</span>
              </div>
              <h4>{h.title}</h4>
              <p>{h.why}</p>
              <div className="hook-actions">
                {h.appliedAt ? (
                  <>
                    <span className="pill"><span className="dot ok" />In the video</span>
                    <button className="btn sm ghost" disabled={!!busy} onClick={() => void api.clearHook(p.id).catch(fail)}>Remove</button>
                  </>
                ) : (
                  <button className="btn primary sm" disabled={!!busy} onClick={() => void use(h)}>{busy === h.id ? "Applying…" : "Use this hook"}</button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
      {missing ? (
        <button className="btn sm" style={{ marginTop: 6 }} onClick={() => void api.renderHookPreviews(p.id).catch(fail)}>Render hook previews</button>
      ) : null}
    </div>
  );
}

/** Guide tracks time the edit but are never in the exported file — say so, and where to start the song. */
export function GuideNotes({ project: p }: { project: Project }) {
  const guides = p.spec.audio.music.filter((m) => m.guide);
  if (!guides.length) return null;
  return (
    <>
      {guides.map((m) => (
        <p key={m.id} className="guide-note">
          <b>Not in this file:</b> “{m.title ?? "guide track"}” only guided the timing. When you post, add it with the app’s own
          music picker{m.offset > 0.5 ? `, starting ${fmtTime(m.offset)} into the song` : ""}
          {m.start > 0.5 ? `, from ${fmtTime(m.start)} of the video` : ""}.
        </p>
      ))}
    </>
  );
}
