import { useEffect, useState } from "react";
import { api, type Brief, type Health, type KeysInfo, night, type NightBatch, type ProjectSummary } from "./api";
import { go, goMusic, goNight } from "./App";

const FORMATS: { id: Brief["platform"]; title: string; sub: string; w: number; h: number }[] = [
  { id: "short", title: "Short / Reel", sub: "9:16 · YouTube Shorts, Instagram Reels, TikTok", w: 36, h: 64 },
  { id: "youtube", title: "YouTube", sub: "16:9 · regular long-form video", w: 80, h: 45 },
  { id: "portrait", title: "Feed post", sub: "4:5 · Instagram feed", w: 48, h: 60 },
  { id: "square", title: "Square", sub: "1:1 · feeds, LinkedIn", w: 54, h: 54 },
];

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function Home() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nightBatches, setNightBatches] = useState<NightBatch[]>([]);

  useEffect(() => {
    void api.projects().then(setProjects).catch((e: Error) => setError(e.message));
    void api.health().then(setHealth).catch(() => {});
    void night.overview().then((o) => setNightBatches(o.batches)).catch(() => {});
  }, []);

  // The shift worth showing: one in progress, else the most recent.
  const nightLatest = nightBatches.find((b) => ["running", "waiting_limit", "queued", "scheduled"].includes(b.state)) ?? nightBatches[0];
  const nightStatus = (() => {
    const b = nightLatest;
    if (!b) return null;
    const ready = b.items.filter((i) => i.state === "done");
    const hooks = ready.reduce((s, i) => s + (i.hooks ?? 0), 0);
    if (b.state === "running" || b.state === "waiting_limit") return { dot: "live", text: `On shift · ${ready.length}/${b.items.length} ready`, review: ready.length > 0 };
    if (b.state === "scheduled") return { dot: "amber", text: `Starts at ${new Date(b.settings.startAt ?? "").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, review: false };
    if (ready.length) return { dot: "ok", text: `${ready.length} video${ready.length === 1 ? "" : "s"} ready${hooks ? ` · ${hooks} hook ideas` : ""}`, review: true };
    return null;
  })();

  const create = async (platform: Brief["platform"]) => {
    setBusy(true);
    try {
      const p = await api.create(name || "Untitled video", platform);
      go(p.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const problems = health
    ? [
        !health.claude && "Claude Code isn't installed or logged in — run `npm i -g @anthropic-ai/claude-code`, then `claude` once to log in.",
        !health.ffmpeg && "ffmpeg is missing — run `bun run setup`.",
        !health.whisper && "Captions engine (whisper.cpp) is missing — run `bun run setup`.",
        !health.faces && "Face model is missing — run `bun run setup`.",
        !health.node && "Node.js is missing (needed for rendering) — install it from nodejs.org.",
      ].filter(Boolean)
    : [];

  return (
    <div className="home">
      <header className="home-hero">
        <div>
          <div className="kicker">Local editing room · open source · runs on your PC</div>
          <h1 className="brand">
            Video <em>Editor</em>
          </h1>
          <p className="tagline">Drop in a video of yourself, say what you want in plain words, and Claude cuts, captions and designs it — right here on your laptop.</p>
        </div>
        <div className="hero-note">
          <p><b>Everything stays on this PC.</b> Rendering, captions and face tracking run locally with free open-source tools.</p>
          <p><b>Claude does the thinking</b> through your own Claude Code — signed in with your Claude plan or your own API key. The app never sees your login.</p>
          <p><b>Your footage only.</b> Links to other creators' videos can be used as a style reference, never downloaded.</p>
        </div>
      </header>

      {problems.length ? (
        <section className="home-block">
          <h2 className="section-title">Before you start</h2>
          <div className="checks">
            {problems.map((p) => (
              <span key={String(p)} className="pill"><span className="dot live" />{p}</span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="home-block home-links">
        <div className="night-promo" onClick={() => goNight(nightStatus ? nightLatest?.id : null)}>
          <div>
            <div className="kicker">Autonomous · no input needed</div>
            <h2>Night <em>Shift</em></h2>
            <p>Hand it a batch of clips at night. Claude edits each one on its own, exports it, and leaves you hook ideas to pick from in the morning.</p>
          </div>
          <div className="promo-side">
            {nightStatus ? <span className="pill"><span className={`dot ${nightStatus.dot}`} />{nightStatus.text}</span> : null}
            <button className="btn primary">{nightStatus?.review ? "Review the dailies →" : "Open Night Shift →"}</button>
          </div>
        </div>
        <div className="night-promo" onClick={goMusic}>
          <div>
            <div className="kicker">Phonk · cinematic · your tracks</div>
            <h2>Music <em>library</em></h2>
            <p>The only music Claude uses: original beats made here plus tracks you're allowed to use. Trending songs as guides.</p>
          </div>
        </div>
      </section>

      <section className="home-block">
        <h2 className="section-title">New video — where will it be posted?</h2>
        <div className="name-row">
          <input className="field" placeholder="Name it (optional) — e.g. “Gym routine reel”" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </div>
        <div className="formats">
          {FORMATS.map((f) => (
            <button key={f.id} className="format-card" disabled={busy} onClick={() => void create(f.id)}>
              <div className="frame" style={{ width: f.w, height: f.h }} />
              <div>
                <h3>{f.title}</h3>
                <p>{f.sub}</p>
              </div>
            </button>
          ))}
        </div>
        {error ? <p className="err">{error}</p> : null}
      </section>

      {projects.length ? (
        <section className="home-block">
          <h2 className="section-title">Recent</h2>
          <div className="recent">
            {projects.map((p) => (
              <div key={p.id} className="recent-card" onClick={() => go(p.id)}>
                <div>
                  <h4>{p.name}</h4>
                  <span className="muted mono" style={{ fontSize: 11 }}>{p.brief.platform} · {ago(p.updatedAt)}</span>
                </div>
                <button
                  className="btn ghost sm icon-btn danger"
                  title="Delete project"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete “${p.name}”? Its uploads, edits and exports are removed from this PC. Your original files elsewhere are untouched.`)) return;
                    try {
                      await api.remove(p.id);
                      setProjects((list) => list.filter((x) => x.id !== p.id));
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >×</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <KeysPanel />
      <ClaudeBilling />
    </div>
  );
}

/** The user's own choice: keep Claude on their plan (never per-use API billing). */
function ClaudeBilling() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void api.settings().then((s) => setOn(s.subscriptionOnly)).catch(() => {});
  }, []);
  if (on === null) return null;
  return (
    <section className="home-block">
      <label className="pill" style={{ cursor: "pointer", gap: 10 }}>
        <input type="checkbox" checked={on} onChange={(e) => void api.setSettings({ subscriptionOnly: e.target.checked }).then((s) => setOn(s.subscriptionOnly))} />
        Subscription only — stop Claude if it would bill an API key instead of my Claude plan
      </label>
    </section>
  );
}

const KEY_TITLES: Record<string, string> = { pexels: "Pexels", pollinations: "Pollinations", huggingface: "Hugging Face" };

/** Optional free keys for stock videos / watermark-free AI images. Values are saved on this PC only. */
function KeysPanel() {
  const [k, setK] = useState<KeysInfo | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void api.keys().then(setK).catch(() => {});
  }, []);
  if (!k) return null;
  const save = async (name: string, value: string | null) => {
    try {
      setK(await api.setKeys({ [name]: value }));
      setDraft((d) => ({ ...d, [name]: "" }));
      setMsg(value ? `${KEY_TITLES[name] ?? name} key saved on this PC.` : `${KEY_TITLES[name] ?? name} key removed.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section className="home-block">
      <h2 className="section-title">Free extras (optional)</h2>
      <p className="muted" style={{ marginTop: -6 }}>Stock photos and AI images already work with no keys. These free keys unlock stock <b>video</b> B-roll and watermark-free AI images for faceless videos. Keys are saved only on this PC.</p>
      <div className="keys">
        {Object.entries(k.info).map(([name, info]) => (
          <div key={name} className="key-row">
            <div className="key-meta">
              <b>{KEY_TITLES[name] ?? name}</b> {k.set[name] ? <span className="pill"><span className="dot ok" />connected</span> : <span className="pill"><span className="dot" />not set</span>}
              <div className="muted" style={{ fontSize: 12 }}>{info.what} — get one free at {info.getAt}</div>
            </div>
            <input className="field" type="password" autoComplete="off" placeholder={k.set[name] ? "•••••• (saved)" : "paste key"} value={draft[name] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))} />
            <button className="btn sm" disabled={!draft[name]?.trim()} onClick={() => void save(name, draft[name]!.trim())}>Save</button>
            {k.set[name] ? <button className="btn ghost sm" onClick={() => void save(name, null)}>Remove</button> : null}
          </div>
        ))}
      </div>
      {msg ? <p className="muted" style={{ fontSize: 12 }}>{msg}</p> : null}
    </section>
  );
}
