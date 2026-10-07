// Guide-track gate: a "guide only" song (one the creator can't license) must NEVER be in an exported file.
// Renders the same 3 s edit twice — the track as normal music (control: must be loud) and as a guide track (must be
// silent) — and measures the audio of each export. Usage: bun scripts/guide-test.ts
import { mkdirSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ffmpegPath, ffprobePath } from "../src/server/config";
import { safeJoin, serveFile } from "../src/server/files";
import { renderVideoJob, warmBundle } from "../src/server/render-client";
import { type CompositionProps, type MediaInfo, parseSpec } from "../src/shared/spec";

const dir = path.join(APP_HOME, "test", "guide");
mkdirSync(dir, { recursive: true });
const ff = (args: string[]) => {
  const r = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

// A silent picture and a loud tone standing in for "the song".
ff(["-f", "lavfi", "-i", "color=c=0x223344:s=360x640:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "silent.mp4")]);
ff(["-f", "lavfi", "-i", "sine=f=440:d=3:sample_rate=44100", "-af", "volume=0.6", path.join(dir, "song.wav")]);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const file = safeJoin(dir, decodeURIComponent(new URL(req.url).pathname.slice(1)));
    return file ? serveFile(req, file) : new Response("bad path", { status: 400 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const media: Record<string, MediaInfo> = {
  V: { id: "V", kind: "video", name: "silent.mp4", src: `${base}/silent.mp4`, width: 360, height: 640, duration: 3, fps: 30, hasAudio: false },
  S: { id: "S", kind: "audio", name: "song.wav", src: `${base}/song.wav`, width: 0, height: 0, duration: 3, fps: 30, hasAudio: true },
};

async function render(guide: boolean): Promise<string> {
  const spec = parseSpec({
    format: { preset: "custom", width: 360, height: 640, fps: 30 },
    clips: [{ id: "c1", mediaId: "V", in: 0, out: 3 }],
    audio: { music: [{ id: "m1", mediaId: "S", volume: 1, fadeIn: 0, fadeOut: 0, duckTo: 1, guide, title: "Trending song" }] },
    captions: { enabled: false },
  });
  const props: CompositionProps = { spec, media, analysis: {}, preview: false, sfxBaseUrl: `${base}/sfx` };
  const out = path.join(dir, guide ? "export-guide.mp4" : "export-music.mp4");
  await renderVideoJob(props, out, () => {}).done;
  return out;
}

/** Loudest sample in dB, or null when the file has no audio stream at all. */
function maxVolume(file: string): number | null {
  const streams = Bun.spawnSync([ffprobePath(), "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]).stdout.toString().trim();
  if (!streams) return null;
  const r = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr.toString());
  return !m || m[1] === "-inf" ? -Infinity : Number(m[1]);
}

let ok = true;
try {
  await warmBundle().done;
  const control = maxVolume(await render(false));
  const guided = maxVolume(await render(true));
  const fmt = (v: number | null) => (v === null ? "no audio stream" : `${v} dB`);
  const c1 = control !== null && control > -40; // lavfi's sine is 1/8 amplitude (-18 dB) before the music mix; silence is < -90
  const c2 = guided === null || guided < -60;
  console.log(`${c1 ? "PASS" : "FAIL"}  control (normal music) is audible in the export: ${fmt(control)}`);
  console.log(`${c2 ? "PASS" : "FAIL"}  guide-only song is NOT in the export: ${fmt(guided)}`);
  ok = c1 && c2;
} catch (e) {
  console.log(`FAIL  ${(e as Error).message}`);
  ok = false;
} finally {
  server.stop(true);
}
console.log(ok ? "\nGUIDE TRACK GATE: PASS" : "\nGUIDE TRACK GATE: FAIL");
process.exit(ok ? 0 : 1);
