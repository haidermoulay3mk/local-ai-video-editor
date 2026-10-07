// Night Shift UI gate: the morning review in headless Microsoft Edge (DevTools protocol, throwaway profile).
// Checks the dailies render, hook previews actually play, and "Use this hook" produces a final video.
// Also saves README screenshots to docs/. Usage: bun scripts/night-smoke.ts <batchId> [--no-apply]
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PORT, ROOT } from "../src/server/config";
import type { NightBatch } from "../src/server/night";
import type { Project } from "../src/server/store";

const batchId = process.argv[2];
if (!batchId) throw new Error("usage: bun scripts/night-smoke.ts <batchId> [--no-apply]");
const apply = !process.argv.includes("--no-apply");
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]
  .find((p) => Bun.file(p).size > 0);
if (!EDGE) throw new Error("Microsoft Edge not found");

const docs = path.join(ROOT, "docs");
const out = path.join(os.tmpdir(), "video-editor-night-smoke");
mkdirSync(docs, { recursive: true });
mkdirSync(out, { recursive: true });
const port = 9333 + Math.floor(Math.random() * 500);
const edge = Bun.spawn([EDGE, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(out, "profile")}`,
  "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdout: "ignore", stderr: "ignore" });

let ws: WebSocket;
let nextId = 1;
const pending = new Map<number, (v: { result?: unknown; error?: { message: string } }) => void>();
const problems: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result as T))));
}
async function evaluate<T>(expression: string): Promise<T> {
  const r = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
async function shot(file: string, fullPage = false) {
  if (fullPage) {
    const h = await evaluate<number>("Math.min(document.querySelector('.home').scrollHeight, 4000)");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
  }
  const r = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.data, "base64"));
  if (fullPage) await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log(`  screenshot: ${file}`);
}
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(label);
};
async function waitFor(expr: string, ms: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await evaluate<boolean>(expr).catch(() => false)) return true;
    await sleep(400);
  }
  return false;
}

try {
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = list.find((t) => t.type === "page");
    } catch { /* Edge still starting */ }
  }
  if (!target) throw new Error("Edge did not start");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: Record<string, unknown> } & { result?: unknown; error?: { message: string } };
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    } else if (m.method === "Inspector.targetCrashed") problems.push("page crashed");
    else if (m.method === "Runtime.exceptionThrown") problems.push(`exception: ${JSON.stringify((m.params as { exceptionDetails?: { text?: string } }).exceptionDetails?.text)}`);
    else if (m.method === "Runtime.consoleAPICalled" && (m.params as { type: string }).type === "error") {
      problems.push(`console.error: ${(m.params as { args: { value?: unknown; description?: string }[] }).args.map((a) => a.value ?? a.description).join(" ").slice(0, 200)}`);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Inspector.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // Home: the Night Shift entry point.
  await send("Page.navigate", { url: `${BASE}/#/` });
  check("home shows the Night Shift entry", await waitFor("!!document.querySelector('.night-promo')", 15000));
  await sleep(800);
  await shot(path.join(docs, "home.png"));

  // The shift page with its morning dailies.
  const b = (await (await fetch(`${BASE}/api/night/${batchId}`)).json()) as NightBatch;
  await send("Page.navigate", { url: `${BASE}/#/night/${batchId}` });
  const videos = b.items.filter((i) => i.state === "done" && i.kind !== "scout"); // a scout item makes no video
  const ready = videos.length;
  check("dailies render one card per finished video", await waitFor(`document.querySelectorAll('.daily').length === ${ready} && ${ready} > 0`, 20000), `${ready} ready`);
  check("each daily has the exported video", await waitFor("[...document.querySelectorAll('.daily .daily-video video')].length === document.querySelectorAll('.daily').length", 15000));
  const cards = await evaluate<number>("document.querySelectorAll('.daily .hook-card').length");
  check("hook cards are shown", cards > 0, `${cards} cards`);
  const playing = await waitFor(
    "[...document.querySelectorAll('.daily .hook-card video')].length > 0 && [...document.querySelectorAll('.daily .hook-card video')].every(v => v.readyState >= 2 && v.currentTime > 0)",
    20000,
  );
  check("hook previews load and autoplay (muted)", playing, await evaluate<string>("[...document.querySelectorAll('.daily .hook-card video')].map(v => v.readyState + '@' + v.currentTime.toFixed(1)).join(' ')"));
  const mainOk = await evaluate<boolean>(
    "Promise.all([...document.querySelectorAll('.daily .daily-video video')].map(v => v.readyState >= 1 ? true : new Promise(r => { v.onloadedmetadata = () => r(true); v.onerror = () => r(false); setTimeout(() => r(false), 10000); }))).then(a => a.every(Boolean))",
  );
  check("exported videos load in the player", mainOk);
  await shot(path.join(docs, "night-dailies.png"), true);

  if (apply) {
    // "Use this hook" on the top-ranked hook of the first video → final render with the hook.
    const it = videos[0]!;
    const before = (await (await fetch(`${BASE}/api/projects/${it.projectId}`)).json()) as Project;
    const top = [...(before.hooks ?? [])].sort((x, y) => y.score - x.score)[0]!;
    await evaluate("document.querySelector('.daily .hook-card .btn.primary').click()");
    check("hook is marked as in the video", await waitFor("!!document.querySelector('.daily .hook-card.chosen')", 15000));
    const t0 = Date.now();
    let after = before;
    while (Date.now() - t0 < 10 * 60_000) {
      after = (await (await fetch(`${BASE}/api/projects/${it.projectId}`)).json()) as Project;
      if (after.exports.some((e) => e.label === `hook-${top.id}`)) break;
      await sleep(3000);
    }
    const final = after.exports.find((e) => e.label === `hook-${top.id}`);
    check("final video with the hook is rendered", !!final, final ? `${final.file} ${final.duration.toFixed(1)} s in ${((Date.now() - t0) / 1000).toFixed(0)} s` : "timed out");
    check("download button switches to the final video", await waitFor("[...document.querySelectorAll('.daily a.btn.primary')].some(a => a.textContent.includes('with hook'))", 15000));
    const nightExport = before.exports.find((e) => e.label === "night");
    if (final && nightExport && top.prepend.length) check("cold-open hook made the video longer", final.duration > nightExport.duration, `${nightExport.duration.toFixed(1)} → ${final.duration.toFixed(1)} s`);
    await shot(path.join(out, "after-apply.png"));
  }

  // Setup screen of a fresh (empty) shift, for the README — deleted afterwards.
  const draft = (await (await fetch(`${BASE}/api/night`, { method: "POST", headers: { "x-video-editor": "1" } })).json()) as NightBatch;
  await send("Page.navigate", { url: `${BASE}/#/night/${draft.id}` });
  check("setup screen renders", await waitFor("!!document.querySelector('.setup .drop')", 15000));
  check("setup offers the 4 kinds of video", await evaluate<boolean>("document.querySelectorAll('.mode-card').length === 4"));
  await evaluate("document.querySelectorAll('.mode-card')[3].click()");
  check("long-form mode shows script, reference link and voice", await waitFor("!!document.querySelector('#night-script') && !!document.querySelector('#night-ref') && !!document.querySelector('#night-voice')", 10000));
  await evaluate("document.querySelectorAll('.mode-card')[2].click()");
  check("long video → shorts mode shows the shorts count", await waitFor("!!document.querySelector('#night-count')", 10000));
  await sleep(600);
  await shot(path.join(docs, "night-setup.png"));
  await fetch(`${BASE}/api/night/${draft.id}`, { method: "DELETE", headers: { "x-video-editor": "1" } });

  // Music library: tracks listed, a track plays in the browser, "Make it" composes an original beat.
  const lib = (await (await fetch(`${BASE}/api/music`, { headers: { "x-video-editor": "1" } })).json()) as { tracks: { id: string }[] };
  await send("Page.navigate", { url: `${BASE}/#/music` });
  check("music library lists every track", await waitFor(`document.querySelectorAll('.track-row').length === ${lib.tracks.length} && ${lib.tracks.length} > 0`, 15000), `${lib.tracks.length} tracks`);
  const plays = await evaluate<string>(
    `new Promise(r => { const a = new Audio('/music-files/${lib.tracks[0]?.id}'); a.muted = true; a.play().catch(e => r('play failed: ' + e.message)); setTimeout(() => r(a.currentTime > 0 ? 'ok' : 'no progress (readyState ' + a.readyState + ')'), 4000); })`,
  );
  check("a library track plays in the browser", plays === "ok", plays);
  await evaluate("[...document.querySelectorAll('.music-page .btn.primary')].find(b => b.textContent.includes('Make it')).click()");
  const made = await waitFor(`document.querySelectorAll('.track-row').length === ${lib.tracks.length + 1}`, 90000);
  check("\"Make it\" composes an original beat", made);
  if (made) {
    const now = (await (await fetch(`${BASE}/api/music`, { headers: { "x-video-editor": "1" } })).json()) as { tracks: { id: string }[] };
    const added = now.tracks.find((t) => !lib.tracks.some((x) => x.id === t.id));
    if (added) await fetch(`${BASE}/api/music/${added.id}`, { method: "DELETE", headers: { "x-video-editor": "1" } });
    await send("Page.reload");
    await waitFor(`document.querySelectorAll('.track-row').length === ${lib.tracks.length}`, 15000);
  }
  await sleep(600);
  await shot(path.join(docs, "music.png"), true);
} catch (e) {
  problems.push(`script error: ${(e as Error).message}`);
} finally {
  edge.kill();
}
const real = problems.filter((p) => !/favicon/i.test(p));
console.log(real.length ? `\nNIGHT UI GATE: FAIL\n- ${real.join("\n- ")}` : "\nNIGHT UI GATE: PASS");
process.exit(real.length ? 1 : 0);
