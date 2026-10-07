// Remotion rendering. Runs ONLY inside the Node render worker (render-worker.ts), never in the Bun server:
// Remotion's renderer targets Node (under Bun it timed out), and webpack would block the server's event loop.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import {
  type RenderMediaOnProgress, makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition,
} from "@remotion/renderer";
import type { CompositionProps } from "../shared/spec";
import { totalFrames } from "../shared/timeline";
import { APP_HOME, ROOT } from "./config";

export type GlMode = "angle" | "swangle" | "egl" | "swiftshader" | "vulkan" | "angle-egl";
// Benchmarked on an i5-1235U / Iris Xe (see VERIFICATION_LOG.md): GPU compositing + WebCodecs decoding
// cut the per-frame video cost ~7x versus software GL + OffthreadVideo.
export const DEFAULT_GL: GlMode | null = (process.env.VIDEO_EDITOR_GL as GlMode | undefined) ?? "angle";
export const DEFAULT_ENGINE: NonNullable<CompositionProps["videoEngine"]> =
  (process.env.VIDEO_EDITOR_VIDEO_ENGINE as "offthread" | "webcodecs" | undefined) ?? "webcodecs";

function sourceHash(): string {
  const h = createHash("sha1");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(path.join(ROOT, "src", "remotion"));
  walk(path.join(ROOT, "src", "shared"));
  h.update(readFileSync(path.join(ROOT, "package.json")));
  return h.digest("hex").slice(0, 12);
}

/** Webpack bundle of src/remotion, cached on disk per source hash (rebuilt only when the code changes). */
export async function getBundle(onProgress?: (p: number) => void): Promise<string> {
  const cacheRoot = path.join(APP_HOME, "cache");
  const outDir = path.join(cacheRoot, `bundle-${sourceHash()}`);
  if (existsSync(path.join(outDir, "index.html"))) return outDir;
  mkdirSync(cacheRoot, { recursive: true });
  for (const old of existsSync(cacheRoot) ? readdirSync(cacheRoot) : []) {
    if (old.startsWith("bundle-")) rmSync(path.join(cacheRoot, old), { recursive: true, force: true });
  }
  return bundle({ entryPoint: path.join(ROOT, "src", "remotion", "index.ts"), outDir, onProgress: (p) => onProgress?.(p) });
}

const concurrency = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 3)));
/** Fewer parallel Chrome tabs when memory is short (each can take several hundred MB): slower beats failing overnight. */
const safeConcurrency = () => Math.max(1, Math.min(concurrency, Math.floor(os.freemem() / (700 * 1024 ** 2))));
const SETUP_TIMEOUT = 120_000; // starting Chrome on a busy PC can take well over Remotion's 30 s default

export type RenderOptions = {
  quality?: "high" | "draft";
  frameRange?: [number, number];
  gl?: GlMode | null;
  concurrency?: number;
};

/** Final renders always use full-quality originals; stills may use the light proxies (props.preview). */
const withDefaults = (props: CompositionProps, forceFull = true): Record<string, unknown> =>
  ({ ...props, preview: forceFull ? false : props.preview, videoEngine: props.videoEngine ?? DEFAULT_ENGINE }) as unknown as Record<string, unknown>;

export function renderVideo(props: CompositionProps, outFile: string, onProgress: RenderMediaOnProgress, opts: RenderOptions = {}) {
  const quality = opts.quality ?? "high";
  const { cancel, cancelSignal } = makeCancelSignal();
  const done = (async () => {
    mkdirSync(path.dirname(outFile), { recursive: true });
    const serveUrl = await getBundle();
    const inputProps = withDefaults(props);
    const gl = opts.gl === undefined ? DEFAULT_GL : opts.gl;
    const composition = await selectComposition({ serveUrl, id: "Main", inputProps, chromiumOptions: { gl }, timeoutInMilliseconds: SETUP_TIMEOUT });
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outFile,
      inputProps,
      crf: quality === "high" ? 18 : 28,
      x264Preset: quality === "high" ? "fast" : "veryfast",
      audioBitrate: "256k",
      pixelFormat: "yuv420p", // plays everywhere (YouTube / Instagram / phones)
      concurrency: opts.concurrency ?? safeConcurrency(),
      scale: quality === "high" ? 1 : 0.5,
      frameRange: opts.frameRange ?? null,
      chromiumOptions: { gl },
      onProgress,
      cancelSignal,
      timeoutInMilliseconds: 120_000,
      overwrite: true,
    });
    return outFile;
  })();
  return { cancel, done };
}

/** Render a few frames as JPEGs (Claude looks at these to check its own edit). Times are output seconds. */
export async function renderStills(props: CompositionProps, times: number[], outDir: string, scale = 0.5): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const serveUrl = await getBundle();
  const inputProps = withDefaults(props, false);
  const browser = await openBrowser("chrome", { chromiumOptions: { gl: DEFAULT_GL } });
  const files: string[] = [];
  try {
    const composition = await selectComposition({ serveUrl, id: "Main", inputProps, puppeteerInstance: browser, timeoutInMilliseconds: SETUP_TIMEOUT });
    const last = totalFrames(props.spec) - 1;
    for (const t of times) {
      const frame = Math.max(0, Math.min(last, Math.round(t * props.spec.format.fps)));
      const output = path.join(outDir, `still-${frame}.jpg`);
      await renderStill({
        composition, serveUrl, frame, output, inputProps, imageFormat: "jpeg", jpegQuality: 80, scale,
        puppeteerInstance: browser, overwrite: true, timeoutInMilliseconds: SETUP_TIMEOUT,
      });
      files.push(output);
    }
  } finally {
    await browser.close({ silent: true });
  }
  return files;
}
