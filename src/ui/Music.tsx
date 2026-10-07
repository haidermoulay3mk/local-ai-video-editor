// Music library: the only music Claude may put in your videos. Add tracks you're allowed to use (with their
// licence), make original beats right here, and mark trending songs as "guide only" (timing, never exported).
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime, music, type MusicLibrary, type Track } from "./api";
import { go } from "./App";

const FREE_SOURCES = [
  { name: "YouTube Audio Library", url: "https://www.youtube.com/audiolibrary", note: "free for YouTube videos" },
  { name: "Pixabay Music", url: "https://pixabay.com/music/", note: "free, includes phonk & cinematic" },
  { name: "NCS", url: "https://ncs.io/", note: "free with a credit line in the description" },
  { name: "StreamBeats", url: "https://www.streambeats.com/", note: "free for creators" },
];

export function Music() {
  const [lib, setLib] = useState<MusicLibrary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const load = useCallback(() => void music.library().then(setLib).catch((e: Error) => setErr(e.message)), []);
  useEffect(load, [load]);
  useEffect(() => () => audio.current?.pause(), []);

  const play = (t: Track) => {
    if (playing === t.id) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const a = new Audio(music.fileUrl(t.id));
    a.onended = () => setPlaying(null);
    void a.play();
    audio.current = a;
    setPlaying(t.id);
  };

  return (
    <div className="home music-page">
      <nav className="crumbs">
        <span className="logo" title="All projects" onClick={() => go(null)}>Video Editor</span>
        <span className="dim">/</span>
        <span className="crumb">Music library</span>
      </nav>
      <header className="night-hero">
        <div>
          <div className="kicker">The only music Claude will use</div>
          <h1 className="brand">Music <em>library</em></h1>
          <p className="tagline">
            Claude picks from here by mood and tempo, lands the drop on the payoff and cuts on the beat. Everything here is
            yours to use — so your videos don't get muted, claimed or taken down.
          </p>
        </div>
        <div className="hero-note">
          <p><b>Free music you can add:</b></p>
          {FREE_SOURCES.map((s) => (
            <p key={s.name} style={{ margin: "4px 0" }}>
              <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a> — {s.note}
            </p>
          ))}
          <p style={{ marginTop: 12 }}>
            <b>A trending song?</b> Add it as <b>Guide only</b>: Claude times the edit to it and you hear it in the preview,
            but it's never put in the exported file — add the sound in Instagram / TikTok / YouTube's own music picker when
            you post (that's licensed there).
          </p>
        </div>
      </header>

      {err ? <p className="err" style={{ maxWidth: 1200, margin: "12px auto 0" }}>{err}</p> : null}
      {lib ? (
        <>
          <section className="home-block setup">
            <AddMusic lib={lib} onAdded={load} onError={setErr} />
            <MakeBeat lib={lib} onMade={load} onError={setErr} />
          </section>
          <section className="home-block">
            <h2 className="section-title">Your tracks <span className="muted mono" style={{ fontSize: 14 }}>{lib.tracks.length}</span></h2>
            {lib.tracks.length ? (
              <div className="reel">
                {lib.tracks.map((t) => (
                  <div key={t.id} className="reel-row track-row">
                    <button className={`btn sm icon-btn ${playing === t.id ? "primary" : ""}`} title={playing === t.id ? "Stop" : "Play"} onClick={() => play(t)}>
                      {playing === t.id ? "■" : "▶"}
                    </button>
                    <span />
                    <div className="reel-main">
                      <b title={t.title}>{t.title}{t.artist ? <span className="muted"> — {t.artist}</span> : null}</b>
                      <span className="mono muted">
                        {t.genre}{t.moods.length ? ` · ${t.moods.join(", ")}` : ""} · {t.bpm ? `${Math.round(t.bpm)} BPM` : "no beat found"} · {fmtTime(t.duration)}
                        {t.drops.length ? ` · ${t.drops.length} drop${t.drops.length > 1 ? "s" : ""}` : ""}
                      </span>
                    </div>
                    <span className={`pill ${t.guideOnly ? "guide" : ""}`} title={lib.licenses[t.license]}>
                      {t.guideOnly ? "Guide only · not exported" : lib.licenses[t.license]?.split(" — ")[0]}
                    </span>
                    <button
                      className="btn ghost sm icon-btn danger"
                      title="Remove from the library (videos already made keep their copy)"
                      onClick={async () => {
                        if (!confirm(`Remove “${t.title}” from the library?`)) return;
                        await music.remove(t.id).catch((e: Error) => setErr(e.message));
                        load();
                      }}
                    >×</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">No tracks yet — add some or make an original beat above.</p>
            )}
          </section>
        </>
      ) : (
        <span className="thinking"><i /><i /><i /> Loading…</span>
      )}
    </div>
  );
}

function AddMusic({ lib, onAdded, onError }: { lib: MusicLibrary; onAdded: () => void; onError: (e: string | null) => void }) {
  const [license, setLicense] = useState("");
  const [genre, setGenre] = useState("other");
  const [moods, setMoods] = useState<string[]>([]);
  const [attribution, setAttribution] = useState("");
  const [uploads, setUploads] = useState<{ name: string; p: number }[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const add = async (list: FileList | null) => {
    if (!license) return onError("First choose where this music comes from (its licence).");
    onError(null);
    for (const f of Array.from(list ?? [])) {
      setUploads((u) => [...u, { name: f.name, p: 0 }]);
      try {
        await music.upload(f, { license, genre, moods, attribution: attribution || undefined }, (p) =>
          setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, p } : x))));
      } catch (e) {
        onError(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploads((u) => u.filter((x) => x.name !== f.name));
        onAdded();
      }
    }
  };

  return (
    <div className="card form">
      <div>
        <h3>Add music</h3>
        <p className="sub" style={{ margin: 0 }}>mp3, wav, m4a… Tempo, beats and drops are detected automatically.</p>
      </div>
      <div>
        <label className="lbl" htmlFor="m-license">Where is it from? (required)</label>
        <select id="m-license" className="field" value={license} onChange={(e) => setLicense(e.target.value)}>
          <option value="" disabled>Choose…</option>
          {Object.entries(lib.licenses).filter(([k]) => k !== "original").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
        <div>
          <label className="lbl" htmlFor="m-genre">Genre</label>
          <select id="m-genre" className="field" value={genre} onChange={(e) => setGenre(e.target.value)}>
            {lib.genres.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div>
          <label className="lbl" htmlFor="m-attr">Credit line (if required)</label>
          <input id="m-attr" className="field" placeholder="e.g. Music: … (NCS)" value={attribution} onChange={(e) => setAttribution(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="lbl">Mood</label>
        <div className="chips">
          {lib.moods.map((m) => (
            <button key={m} className={`chip ${moods.includes(m) ? "on" : ""}`} onClick={() => setMoods((x) => (x.includes(m) ? x.filter((y) => y !== m) : [...x, m].slice(0, 5)))}>{m}</button>
          ))}
        </div>
      </div>
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
          void add(e.dataTransfer.files);
        }}
      >
        <strong>Drop music files here</strong>or click to choose
        <input ref={input} type="file" accept="audio/*" multiple hidden onChange={(e) => void add(e.target.files)} />
      </div>
      {uploads.map((u) => (
        <div key={u.name} className="file-row">
          <span className="name">{u.name}</span>
          <div className="bar" style={{ width: 90, margin: 0 }}><i style={{ width: `${u.p * 100}%` }} /></div>
          <span className="muted mono" style={{ fontSize: 11 }}>{u.p < 1 ? `${Math.round(u.p * 100)}%` : "analysing…"}</span>
        </div>
      ))}
    </div>
  );
}

function MakeBeat({ lib, onMade, onError }: { lib: MusicLibrary; onMade: () => void; onError: (e: string | null) => void }) {
  const styles = Object.entries(lib.styles);
  const [style, setStyle] = useState(styles[0]?.[0] ?? "phonk");
  const [bpm, setBpm] = useState(lib.styles[style]?.bpm ?? 120);
  const [seconds, setSeconds] = useState(90);
  const [busy, setBusy] = useState(false);

  return (
    <div className="card form">
      <div>
        <h3>Make an original beat</h3>
        <p className="sub" style={{ margin: 0 }}>
          Composed right here on your PC — 100% yours, never claimed. Simple but solid beats with a real intro, drop and break.
        </p>
      </div>
      <div>
        <label className="lbl">Style</label>
        <div className="seg wrap">
          {styles.map(([k, v]) => (
            <button key={k} className={style === k ? "on" : ""} onClick={() => {
              setStyle(k);
              setBpm(v.bpm);
            }}>{v.label}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 14, alignItems: "end" }}>
        <div>
          <label className="lbl" htmlFor="m-bpm">Tempo · {bpm} BPM</label>
          <input id="m-bpm" type="range" min={60} max={180} value={bpm} onChange={(e) => setBpm(Number(e.target.value))} />
        </div>
        <div>
          <label className="lbl">Length</label>
          <div className="seg">
            {[45, 90, 180].map((s) => <button key={s} className={seconds === s ? "on" : ""} onClick={() => setSeconds(s)}>{s < 60 ? `${s}s` : `${s / 60}m`}</button>)}
          </div>
        </div>
      </div>
      <div className="start-box">
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true);
          onError(null);
          try {
            await music.generate(style, bpm, seconds);
            onMade();
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}>{busy ? "Composing…" : "Make it"}</button>
        <span className="muted" style={{ fontSize: 12.5 }}>Takes a few seconds. Claude can also make one by itself when nothing fits.</span>
      </div>
    </div>
  );
}
