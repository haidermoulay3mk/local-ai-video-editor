// The "Director" panel: talk to Claude, watch what it's doing, answer its questions.
import { useEffect, useRef, useState } from "react";
import { api, type Project, type Usage } from "./api";

// Ready-made prompts for people who don't know how to ask an editor. They fill the box; you can edit before sending.
const RECIPES: { title: string; blurb: string; prompt: string }[] = [
  { title: "Viral Short / Reel", blurb: "Fast cuts, bold word-by-word captions, hook, zooms, sound effects",
    prompt: "Make this a high-retention Short/Reel: cut every pause and filler word, bold word-by-word captions, a hook title in the first 2 seconds, snap zooms on the key words, whoosh/pop sound effects on graphics, a progress bar, and a vibrant look." },
  { title: "Clean YouTube video", blurb: "Natural pace, subtle captions, name title, subscribe reminder",
    prompt: "Edit this as a clean YouTube video: remove long pauses and filler words but keep a natural pace, minimal captions at the bottom, a lower third with my name early on, chapter titles when the topic changes, a subscribe reminder at a natural pause, and a warm clean look." },
  { title: "Glow-up (face & light)", blurb: "Subtle skin smoothing, soft key light, warmer colours, cleaner voice",
    prompt: "Make me look and sound better: subtle skin smoothing, a soft key light on my face, a warm clean colour grade, and clean up my voice. Keep it natural, not filtered." },
  { title: "Cinematic vlog", blurb: "Smooth transitions, film look, elegant titles",
    prompt: "Give this a cinematic vlog feel: smooth transitions between moments, a teal-orange grade with light grain and a soft vignette, elegant minimal titles, and gentle slow zooms." },
  { title: "Tutorial with callouts", blurb: "Numbered steps, arrows pointing at things, clear captions",
    prompt: "Edit this as a tutorial: cut dead air, add a numbered list item for each step, callouts/arrows pointing at important things on screen, and clear minimal captions." },
  { title: "Arabic captions", blurb: "Right-to-left captions in an Arabic font",
    prompt: "My video is in Arabic: add bold Arabic captions (right-to-left) in the Cairo font and fix any obvious transcription mistakes." },
  { title: "Match a style I like", blurb: "Describe a creator/video whose style you want (add the link as a style reference)",
    prompt: "Match this style: [describe what you like — the captions, colours, pacing, graphics, sound effects]." },
];

const MODELS = [
  { id: "sonnet", label: "Sonnet · fast, light on your usage" },
  { id: "opus", label: "Opus · best taste, uses more" },
  { id: "haiku", label: "Haiku · quickest" },
];

const STATUS: Record<string, { label: string; dot: string }> = {
  idle: { label: "Ready", dot: "" },
  starting: { label: "Thinking", dot: "amber" },
  working: { label: "Working", dot: "amber" },
  needs_user: { label: "Needs you", dot: "live" },
  done: { label: "Done", dot: "ok" },
  error: { label: "Problem", dot: "live" },
};

export function Director({ project, usage }: { project: Project; usage: Usage | null }) {
  const [text, setText] = useState("");
  const [model, setModel] = useState(project.claude.model ?? "sonnet");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const status = project.claude.status;
  const busy = status === "starting" || status === "working";
  const ready = project.media.some((m) => m.steps.probe?.state === "done");

  useEffect(() => {
    // Follow the conversation; but keep the recipe list (empty chat) scrolled to its heading.
    if (project.chat.length) list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [project.chat.length, status]);

  const send = async (msg: string) => {
    const t = msg.trim();
    if (!t) return;
    setSending(true);
    setErr(null);
    try {
      await api.chat(project.id, t, model);
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const five = usage?.unifiedWindows?.five_hour?.utilization;
  const st = STATUS[status] ?? STATUS.idle!;

  return (
    <div className="chat">
      <div className="chat-h">
        <div className="row">
          <h2>Director</h2>
          <span className="pill"><span className={`dot ${st.dot}`} />{st.label}</span>
          <span className="spacer" />
          {busy ? <button className="btn sm danger" onClick={() => void api.stop(project.id)}>Stop</button> : null}
        </div>
        <div className="row">
          <select className="field" style={{ height: 30, padding: "0 28px 0 10px", fontSize: 12.5 }} value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {five !== undefined ? (
            <span className="usage" title="Your Claude plan's 5-hour usage window (from Claude Code)">
              5h use <span className="bar"><i style={{ width: `${Math.round(five * 100)}%`, background: five > 0.8 ? "var(--tally)" : undefined }} /></span>
              {Math.round(five * 100)}%
            </span>
          ) : null}
        </div>
      </div>

      <div className="msgs" ref={list}>
        {project.chat.length === 0 ? (
          <div className="recipes">
            <div className="kicker" style={{ marginBottom: 4 }}>Not sure what to ask? Start from a recipe</div>
            {RECIPES.map((r) => (
              <button key={r.title} className="recipe" onClick={() => { setText(r.prompt); box.current?.focus(); }}>
                <b>{r.title}</b>
                <span>{r.blurb}</span>
              </button>
            ))}
          </div>
        ) : (
          project.chat.map((m) =>
            m.role === "tool" ? (
              <div key={m.id} className={`msg tool ${m.tool?.ok === false ? "fail" : ""}`}>
                <span className={`dot ${m.tool?.ok === false ? "live" : "amber"}`} />
                {m.text}
              </div>
            ) : (
              <div key={m.id} className={`msg ${m.role}`}>{m.text}</div>
            ),
          )
        )}
        {busy ? <div className="thinking"><i /><i /><i /> {project.claude.message ?? "Claude is editing…"}</div> : null}
      </div>

      {!busy && project.claude.options?.length ? (
        <div className="options">
          {project.claude.options.map((o) => <button key={o} className="chip" onClick={() => void send(o)}>{o}</button>)}
        </div>
      ) : null}

      <div className="composer">
        <textarea
          ref={box}
          className="field"
          placeholder={ready ? "Tell Claude what you want… e.g. “make it a 30-second reel with bold captions”" : "Add a video first — then tell Claude what you want."}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <div className="row">
          <span className="hint">Enter to send · Shift+Enter for a new line · uses your own Claude Code</span>
          <span className="spacer" />
          <button className="btn primary" disabled={sending || !text.trim()} onClick={() => void send(text)}>{busy ? "Send (queued)" : "Send"}</button>
        </div>
        {err ? <div className="err">{err}</div> : null}
      </div>
    </div>
  );
}
