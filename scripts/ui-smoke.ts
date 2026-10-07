// P4 UI gate: drive the real UI in headless Microsoft Edge (full H.264/AAC support) over the
// DevTools protocol. Uses a throwaway profile in the temp folder — never your real browser profile.
// Usage: bun scripts/ui-smoke.ts <projectId> [--export] [--publish]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectId = process.argv[2];
const doExport = process.argv.includes("--export");
const showPublish = process.argv.includes("--publish"); // also screenshot the Export menu (publish kit)
if (!projectId) throw new Error("usage: bun scripts/ui-smoke.ts <projectId> [--export]");
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]
  .find((p) => Bun.file(p).size > 0);
if (!EDGE) throw new Error("Microsoft Edge not found");

const out = path.join(os.tmpdir(), "video-editor-ui-smoke");
const profile = path.join(out, "profile");
mkdirSync(out, { recursive: true });
const port = 9333 + Math.floor(Math.random() * 500);
const edge = Bun.spawn([EDGE, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1440,900",
  "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore" });

let ws: WebSocket;
let nextId = 1;
const pending = new Map<number, (v: { result?: unknown; error?: { message: string } }) => void>();
const problems: string[] = [];
let crashed = false;

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
async function shot(name: string) {
  const r = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const file = path.join(out, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  screenshot: ${file}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

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
    } else if (m.method === "Inspector.targetCrashed") {
      crashed = true;
    } else if (m.method === "Runtime.exceptionThrown") {
      problems.push(`exception: ${JSON.stringify((m.params as { exceptionDetails?: { text?: string } }).exceptionDetails?.text)}`);
    } else if (m.method === "Runtime.consoleAPICalled" && (m.params as { type: string }).type === "error") {
      const args = (m.params as { args: { value?: unknown; description?: string }[] }).args.map((a) => a.value ?? a.description).join(" ");
      problems.push(`console.error: ${String(args).slice(0, 200)}`);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Inspector.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await send("Page.navigate", { url: `http://127.0.0.1:4600/#/p/${projectId}` });
  await sleep(6000);
  check("editor loads with the preview player", await evaluate<boolean>("!!document.querySelector('.screen')"));
  await shot("1-loaded");

  await evaluate("(()=>{const el=document.querySelector('.tl-inner');const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.x+r.width*0.12,clientY:r.y+10}))})()");
  await sleep(3000);
  const tc1 = await evaluate<string>("document.querySelector('.slate .tc').textContent");
  check("timeline click seeks the preview", tc1 !== "00:00:00:00", tc1);
  await shot("2-seeked");

  await evaluate("(()=>{const b=[...document.querySelectorAll('.screen button')][0];b&&b.click()})()");
  await sleep(2500);
  const tc2 = await evaluate<string>("document.querySelector('.slate .tc').textContent");
  check("play advances the timecode", tc2 !== tc1, `${tc1} → ${tc2}`);
  await evaluate("(()=>{const b=[...document.querySelectorAll('.screen button')][0];b&&b.click()})()");
  check("page did not crash during playback", !crashed);

  if (showPublish) {
    await evaluate("document.querySelector('.export-wrap > .btn.primary').click()");
    await sleep(2500);
    check("export menu shows the publish kit", await evaluate<boolean>("!!document.querySelector('.publish-kit')"));
    await shot("4-publish");
    await evaluate("document.querySelector('.export-wrap > .btn.primary').click()");
    await sleep(500);
  }
  if (doExport) {
    await evaluate("document.querySelector('.export-wrap > .btn.primary').click()");
    await sleep(500);
    await evaluate("document.querySelector('.popover .btn.primary').click()");
    await sleep(6000);
    const label = await evaluate<string>("document.querySelector('.export-wrap > .btn').innerText");
    check("export starts from the Export menu", /Rendering/.test(label), label);
    await shot("3-exporting");
  }
  check("no console errors or exceptions", problems.filter((p) => !/^(timeline|play|export|editor|page)/.test(p)).length === 0, problems.join(" | "));
} finally {
  try { ws!.close(); } catch { /* ignore */ }
  edge.kill();
  await edge.exited;
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold files briefly */ }
}
console.log(problems.length ? `\nUI SMOKE: FAIL (${problems.length})` : "\nUI SMOKE: PASS");
process.exit(problems.length ? 1 : 0);
