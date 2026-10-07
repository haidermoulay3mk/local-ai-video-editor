// One render at a time (each uses every CPU core), but any number can wait in line:
// manual exports, "Use this hook" re-renders and Night Shift's overnight work all share this queue.
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoredHook } from "./store";
import { type CompositionProps, type Spec } from "../shared/spec";
import { subtitleCues, toSrt } from "../shared/publish";
import { totalSeconds } from "../shared/timeline";
import { emit } from "./bus";
import { masterAudio } from "./media";
import { type JobHandle, renderVideoJob } from "./render-client";
import { compositionProps, getProject, now, type Project, projectDir, saveProject } from "./store";

type Req = {
  projectId: string;
  kind: "export" | "hook";
  label?: string;
  hookId?: string;
  quality: "high" | "draft";
  frameRange?: [number, number];
  props: CompositionProps; // snapshot taken when queued
  out: string;
  resolve: (file: string | null) => void;
};

const queue: Req[] = [];
let current: { req: Req; job: JobHandle<string> } | null = null;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "video";
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export function renderState(projectId: string) {
  return {
    running: current?.req.projectId === projectId && current.req.kind === "export",
    queued: queue.filter((r) => r.projectId === projectId && r.kind === "export").length,
    file: current?.req.projectId === projectId && current.req.kind === "export" ? path.basename(current.req.out) : null,
  };
}

/** Queue a full export of the project's current edit. Resolves with the file name, or null on failure. */
export function queueExport(p: Project, quality: "high" | "draft", label?: string): Promise<string | null> {
  if (!p.spec.clips.length && !p.spec.overlays.length) return Promise.reject(new Error("Nothing to render yet."));
  const tag = label ? `-${slug(label).slice(0, 24)}` : "";
  const file = `${slug(p.name)}-${p.spec.format.preset}-${stamp()}${tag}${quality === "draft" ? "-draft" : ""}.mp4`;
  return enqueue({
    projectId: p.id, kind: "export", label, quality,
    props: compositionProps(p, false), out: path.join(projectDir(p.id), "exports", file),
  });
}

/** Queue a short draft render of the opening with a hook applied (what the creator previews in the morning). */
export function queueHookPreview(p: Project, hook: StoredHook, hooked: Spec, seconds: number): Promise<string | null> {
  const fps = hooked.format.fps;
  const last = Math.max(1, Math.min(Math.round(totalSeconds(hooked) * fps), Math.round(seconds * fps)) - 1);
  return enqueue({
    projectId: p.id, kind: "hook", hookId: hook.id, quality: "draft", frameRange: [0, last],
    props: { ...compositionProps(p, false), spec: hooked }, out: path.join(projectDir(p.id), "hooks", `${hook.id}.mp4`),
  });
}

function enqueue(r: Omit<Req, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ ...r, resolve });
    if (r.kind === "export" && current) emit({ type: "render", projectId: r.projectId, state: "queued" });
    void pump();
  });
}

/** Cancel everything queued or running for a project (or for every project). */
export function cancelRenders(projectId?: string) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!projectId || queue[i]!.projectId === projectId) queue.splice(i, 1)[0]!.resolve(null);
  }
  if (current && (!projectId || current.req.projectId === projectId)) current.job.cancel();
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const req = queue.shift()!;
      mkdirSync(path.dirname(req.out), { recursive: true });
      const job = renderVideoJob(req.props, req.out, (pr) => {
        if (req.kind === "export") emit({ type: "render", projectId: req.projectId, state: "running", progress: pr.progress });
      }, { quality: req.quality, frameRange: req.frameRange });
      current = { req, job };
      if (req.kind === "export") emit({ type: "render", projectId: req.projectId, state: "running", progress: 0 });
      else setHook(req.projectId, req.hookId!, { previewState: "rendering" });
      try {
        await job.done;
        if (req.kind === "export") {
          // Platforms normalise loudness to about -14 LUFS: master the final mix to exactly that.
          try {
            await masterAudio(req.out);
          } catch (e) {
            console.warn("loudness mastering skipped:", (e as Error).message);
          }
          // Subtitle file next to the video (upload it to YouTube for searchable, toggleable captions).
          const cues = subtitleCues(req.props.spec, req.props.analysis);
          if (cues.length) writeFileSync(req.out.replace(/\.mp4$/i, ".srt"), toSrt(cues));
        }
        const p = getProject(req.projectId);
        if (p && req.kind === "export") {
          p.exports.unshift({
            file: path.basename(req.out), createdAt: now(), preset: req.props.spec.format.preset,
            size: statSync(req.out).size, duration: totalSeconds(req.props.spec), label: req.label,
          });
          saveProject(p);
          emit({ type: "render", projectId: req.projectId, state: "done", file: path.basename(req.out) });
        } else if (p) {
          setHook(req.projectId, req.hookId!, { previewState: "done", preview: `hooks/${path.basename(req.out)}` });
        }
        req.resolve(path.basename(req.out));
      } catch (err) {
        rmSync(req.out, { force: true });
        const msg = (err as Error).message;
        if (req.kind === "export") {
          emit({ type: "render", projectId: req.projectId, state: msg === "cancelled" ? "cancelled" : "error", error: msg.slice(0, 600) });
        } else {
          setHook(req.projectId, req.hookId!, { previewState: "error" });
        }
        req.resolve(null);
      } finally {
        current = null;
      }
    }
  } finally {
    pumping = false;
  }
}

function setHook(projectId: string, hookId: string, patch: Partial<StoredHook>) {
  const p = getProject(projectId);
  const h = p?.hooks?.find((x) => x.id === hookId);
  if (!p || !h) return;
  Object.assign(h, patch);
  saveProject(p);
}
