// Upload pipeline: probe -> (master) -> proxy -> audio -> transcript -> silences -> faces -> voice enhance.
// One file at a time (these steps saturate the CPU); every step reports progress and fails independently.
import { existsSync } from "node:fs";
import path from "node:path";
import { emit } from "./bus";
import { detectFaces } from "./faces";
import { analyzeLook, autoFixOptions, type FixOptions, fixFootage, type LookAnalysis } from "./look";
import { detectSilences, enhanceVoice, extractAudio16k, makeMaster, makeProxy, needsMaster, type Probe, probe } from "./media";
import { getAnalysis, getProject, mediaDir, now, patchAnalysis, setStep, type StepName, updateMedia } from "./store";
import { repairTimings, transcribe } from "./transcribe";

// One heavy media job at a time (analysis, footage fixes): they all saturate the CPU.
const queue: { key: string; run: () => Promise<void>; resolve: () => void }[] = [];
let busy = false;

const inflight = new Map<string, Promise<void>>(); // job key -> pending job (never queue the same job twice)

function enqueue(key: string, run: () => Promise<void>): Promise<void> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = new Promise<void>((resolve) => {
    queue.push({ key, run, resolve });
    void pump();
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Queue a file for analysis. The promise resolves when its pipeline has finished (any step may have failed). */
export function enqueueIngest(projectId: string, mediaId: string): Promise<void> {
  return enqueue(`${projectId}/${mediaId}`, () => ingest(projectId, mediaId));
}

/**
 * Fix a video's footage (stabilize / denoise / exposure / white balance) into fixed.mp4 and make it the
 * render source. Options default to the analysis' advice. Proxy, face track and look are refreshed.
 */
export function fixMedia(projectId: string, mediaId: string, opts?: FixOptions): Promise<void> {
  return enqueue(`${projectId}/${mediaId}/fix`, () => doFix(projectId, mediaId, opts));
}

/** Go back to the unfixed footage. */
export function undoFix(projectId: string, mediaId: string): Promise<void> {
  return enqueue(`${projectId}/${mediaId}/unfix`, () => doUndoFix(projectId, mediaId));
}

export const ingestQueueLength = () => queue.length + (busy ? 1 : 0);

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        await job.run();
      } catch (err) {
        console.error("media job failed", job.key, err);
      } finally {
        job.resolve();
      }
    }
  } finally {
    busy = false;
  }
}

async function step<T>(pid: string, mid: string, name: StepName, fn: (progress: (p: number) => void) => Promise<T>): Promise<T | undefined> {
  setStep(pid, mid, name, { state: "running", progress: 0 });
  let lastEmit = 0;
  const progress = (p: number) => {
    const now = Date.now();
    if (now - lastEmit < 300 && p < 1) return;
    lastEmit = now;
    emit({ type: "progress", projectId: pid, mediaId: mid, task: name, progress: p });
  };
  try {
    const out = await fn(progress);
    setStep(pid, mid, name, { state: "done", progress: 1 });
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStep(pid, mid, name, { state: "error", error: message.slice(0, 500) });
    return undefined;
  }
}

const skip = (pid: string, mid: string, names: StepName[]) => {
  for (const n of names) setStep(pid, mid, n, { state: "skipped" });
};

async function ingest(pid: string, mid: string) {
  const p = getProject(pid);
  const m = p?.media.find((x) => x.id === mid);
  if (!p || !m) return;
  const dir = mediaDir(pid, mid);
  const original = path.join(dir, m.original);

  const info = await step(pid, mid, "probe", async () => {
    const pr = await probe(original);
    updateMedia(pid, mid, (r) => {
      r.kind = pr.kind;
      r.width = pr.width;
      r.height = pr.height;
      r.duration = pr.duration;
      r.fps = pr.fps;
      r.hasAudio = pr.hasAudio;
    });
    return pr;
  });
  if (!info) return skip(pid, mid, ["proxy", "audio", "transcript", "silences", "faces", "enhance", "look"]);

  if (info.kind === "image") return skip(pid, mid, ["proxy", "audio", "transcript", "silences", "faces", "enhance", "look"]);

  let renderSource = original;
  if (info.kind === "video") {
    if (needsMaster(info)) {
      // Rotated phone footage / unusual codecs: normalise once so preview and render agree.
      await step(pid, mid, "proxy", async (prog) => {
        await makeMaster(original, path.join(dir, "master.mp4"), info, (x) => prog(x * 0.5));
        updateMedia(pid, mid, (r) => { r.render = "master.mp4"; });
        renderSource = path.join(dir, "master.mp4");
        await makeProxy(renderSource, path.join(dir, "proxy.mp4"), { ...info, rotation: 0 }, (x) => prog(0.5 + x * 0.5));
        updateMedia(pid, mid, (r) => { r.proxy = "proxy.mp4"; });
      });
    } else {
      await step(pid, mid, "proxy", async (prog) => {
        await makeProxy(original, path.join(dir, "proxy.mp4"), info, prog);
        updateMedia(pid, mid, (r) => { r.proxy = "proxy.mp4"; });
      });
    }
  } else {
    skip(pid, mid, ["proxy", "faces"]);
  }

  if (info.hasAudio) {
    const wav = path.join(dir, "audio16k.wav");
    const audioOk = await step(pid, mid, "audio", async () => {
      await extractAudio16k(renderSource, wav);
      return true;
    });
    if (audioOk) {
      // Silences first: they're needed to repair whisper's occasional collapsed word timings.
      const silences = await step(pid, mid, "silences", async () => {
        const s = await detectSilences(wav);
        patchAnalysis(pid, mid, { silences: s });
        return s;
      });
      // Music files don't need a transcript; anything with speech does.
      if (info.kind === "video" || info.duration < 900) {
        await step(pid, mid, "transcript", async (prog) => {
          const { words, language } = await transcribe(wav, dir, prog);
          patchAnalysis(pid, mid, { words: repairTimings(words, silences ?? []), language });
        });
      } else {
        skip(pid, mid, ["transcript"]);
      }
    } else {
      skip(pid, mid, ["transcript", "silences"]);
    }
  } else {
    skip(pid, mid, ["audio", "transcript", "silences", "enhance"]);
  }

  if (info.kind === "video") {
    await step(pid, mid, "faces", async (prog) => {
      patchAnalysis(pid, mid, { faces: await detectFaces(renderSource, { ...info, rotation: 0 } as Probe, prog) });
    });
    // Picture health (exposure, colour, shake) from the light proxy — feeds the "Fix footage" advice.
    await step(pid, mid, "look", async () => {
      const proxy = path.join(dir, "proxy.mp4");
      saveLook(pid, mid, await analyzeLook(existsSync(proxy) ? proxy : renderSource, dir));
    });
  } else {
    skip(pid, mid, ["look"]);
  }

  if (info.hasAudio && info.kind === "video") {
    await step(pid, mid, "enhance", async (prog) => {
      await enhanceVoice(renderSource, path.join(dir, "enhanced.m4a"), info.duration, prog);
      updateMedia(pid, mid, (r) => { r.enhanced = "enhanced.m4a"; });
    });
  } else if (info.hasAudio) {
    skip(pid, mid, ["enhance"]);
  }
  emit({ type: "project", projectId: pid });
}

async function doFix(pid: string, mid: string, opts?: FixOptions) {
  const m = getProject(pid)?.media.find((x) => x.id === mid);
  if (!m || m.kind !== "video") throw new Error("only videos can be fixed");
  const dir = mediaDir(pid, mid);
  const base = m.fixed ? (m.fixedFrom ?? m.original) : (m.render ?? m.original); // always fix from the unfixed footage
  const look = getAnalysis(pid, mid).look;
  if (!look) throw new Error("this video hasn't been analysed yet");
  const o = opts ?? autoFixOptions(look);
  if (!o || !(o.stabilize || o.denoise || o.color || o.whiteBalance || o.sharpen)) return;
  const ok = await step(pid, mid, "fix", async (prog) => {
    await fixFootage(path.join(dir, base), path.join(dir, "fixed.mp4"), dir, look, o, m.duration, (x) => prog(x * 0.8));
    updateMedia(pid, mid, (r) => {
      r.fixedFrom = base;
      r.render = "fixed.mp4";
      r.fixed = { ...o, at: now() };
    });
    await makeProxy(path.join(dir, "fixed.mp4"), path.join(dir, "proxy.mp4"), { kind: "video", width: m.width, height: m.height, fps: m.fps, duration: m.duration, hasAudio: m.hasAudio, rotation: 0 }, (x) => prog(0.8 + x * 0.2));
    return true;
  });
  if (ok) await refreshVisuals(pid, mid, path.join(dir, "fixed.mp4"));
}

async function doUndoFix(pid: string, mid: string) {
  const m = getProject(pid)?.media.find((x) => x.id === mid);
  if (!m?.fixed) return;
  const dir = mediaDir(pid, mid);
  const base = m.fixedFrom ?? m.original;
  updateMedia(pid, mid, (r) => {
    r.render = base === r.original ? undefined : base;
    r.fixed = undefined;
    r.fixedFrom = undefined;
  });
  setStep(pid, mid, "fix", { state: "skipped" });
  await step(pid, mid, "proxy", async (prog) => {
    await makeProxy(path.join(dir, base), path.join(dir, "proxy.mp4"), { kind: "video", width: m.width, height: m.height, fps: m.fps, duration: m.duration, hasAudio: m.hasAudio, rotation: 0 }, prog);
  });
  await refreshVisuals(pid, mid, path.join(dir, base));
}

/** Stabilization shifts/zooms the picture: re-track the face and re-measure the look on the new source. */
async function refreshVisuals(pid: string, mid: string, source: string) {
  const m = getProject(pid)?.media.find((x) => x.id === mid);
  if (!m) return;
  const dir = mediaDir(pid, mid);
  const info: Probe = { kind: "video", width: m.width, height: m.height, fps: m.fps, duration: m.duration, hasAudio: m.hasAudio, rotation: 0 };
  await step(pid, mid, "faces", async (prog) => patchAnalysis(pid, mid, { faces: await detectFaces(source, info, prog) }));
  await step(pid, mid, "look", async () => saveLook(pid, mid, await analyzeLook(path.join(dir, "proxy.mp4"), dir)));
  emit({ type: "project", projectId: pid });
}

function saveLook(pid: string, mid: string, look: LookAnalysis) {
  patchAnalysis(pid, mid, { look });
  updateMedia(pid, mid, (r) => {
    r.lookSummary = { notes: look.advice.notes, fixable: !!autoFixOptions(look), tint: !!look.advice.whiteBalance };
  });
}

/** Re-run ingest for media whose steps never finished (e.g. the app was closed mid-way). */
export function resumeIncomplete(projectIds: string[]) {
  for (const id of projectIds) {
    const p = getProject(id);
    for (const m of p?.media ?? []) {
      const unfinished = Object.values(m.steps).some((s) => s?.state === "running" || s?.state === "pending");
      if ((unfinished || !m.steps.probe) && existsSync(path.join(mediaDir(id, m.id), m.original))) enqueueIngest(id, m.id);
    }
  }
}
