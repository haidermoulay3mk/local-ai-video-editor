// Bun-side handle for the Node render worker. One job = one short-lived Node process.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CompositionProps } from "../shared/spec";
import { APP_HOME, ROOT } from "./config";

export type RenderProgress = { progress: number; rendered?: number; encoded?: number; stage?: string };
export type RenderOpts = { quality?: "high" | "draft"; frameRange?: [number, number]; concurrency?: number };

type Job =
  | { type: "video"; props: CompositionProps; outFile: string; opts?: RenderOpts }
  | { type: "stills"; props: CompositionProps; times: number[]; outDir: string; scale?: number }
  | { type: "bundle" };

export type JobHandle<T> = { cancel: () => void; done: Promise<T> };

function killTree(pid: number) {
  // Kill node AND the headless Chrome processes it started (Windows needs /T for the tree).
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  else process.kill(pid, "SIGKILL");
}

function runJob<T>(job: Job, onProgress?: (p: RenderProgress) => void): JobHandle<T> {
  const jobsDir = path.join(APP_HOME, "cache", "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const jobFile = path.join(jobsDir, `${crypto.randomUUID()}.json`);
  writeFileSync(jobFile, JSON.stringify(job));
  const proc = Bun.spawn(["node", "--import", "tsx", path.join(ROOT, "src", "server", "render-worker.ts"), jobFile], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  let cancelled = false;
  const done = (async () => {
    let result: T | undefined;
    let error: string | undefined;
    let pending = "";
    let logTail = "";
    const dec = new TextDecoder();
    const stderrText = new Response(proc.stderr).text();
    for await (const chunk of proc.stdout) {
      pending += dec.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("@@")) {
          logTail = (logTail + line + "\n").slice(-2000);
          continue;
        }
        const msg = JSON.parse(line.slice(2)) as { event: string; result?: T; message?: string } & RenderProgress;
        if (msg.event === "progress") onProgress?.(msg);
        else if (msg.event === "done") result = msg.result;
        else if (msg.event === "error") error = msg.message;
      }
    }
    const code = await proc.exited;
    rmSync(jobFile, { force: true });
    if (cancelled) throw new Error("cancelled");
    if (result !== undefined && code === 0) return result;
    const stderr = (await stderrText).slice(-1500);
    throw new Error(error ?? `render worker exited with code ${code}: ${stderr || logTail}`);
  })();
  return {
    cancel: () => {
      cancelled = true;
      killTree(proc.pid);
    },
    done,
  };
}

export const renderVideoJob = (props: CompositionProps, outFile: string, onProgress: (p: RenderProgress) => void, opts?: RenderOpts) =>
  runJob<string>({ type: "video", props, outFile, opts }, onProgress);

export const renderStillsJob = (props: CompositionProps, times: number[], outDir: string, scale = 0.5) =>
  runJob<string[]>({ type: "stills", props, times, outDir, scale });

/** Build (or reuse) the cached webpack bundle so the first render doesn't pay for it. */
export const warmBundle = () => runJob<string>({ type: "bundle" });
