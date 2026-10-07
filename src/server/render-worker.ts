// Node process that performs ONE render job and exits (fresh process per job = no leaked decoder state).
// Spawned by render-client.ts:  node --import tsx src/server/render-worker.ts <job.json>
// Reports on stdout as lines prefixed with "@@" + JSON.
import { readFileSync } from "node:fs";
import type { CompositionProps } from "../shared/spec";
import { getBundle, type RenderOptions, renderStills, renderVideo } from "./render";

type Job =
  | { type: "video"; props: CompositionProps; outFile: string; opts?: RenderOptions }
  | { type: "stills"; props: CompositionProps; times: number[]; outDir: string; scale?: number }
  | { type: "bundle" };

const send = (msg: Record<string, unknown>) => process.stdout.write(`@@${JSON.stringify(msg)}\n`);

async function main() {
  const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Job;
  if (job.type === "bundle") {
    const dir = await getBundle((p) => send({ event: "progress", progress: p / 100, stage: "bundling" }));
    send({ event: "done", result: dir });
  } else if (job.type === "stills") {
    const files = await renderStills(job.props, job.times, job.outDir, job.scale);
    send({ event: "done", result: files });
  } else {
    let last = 0;
    const r = renderVideo(job.props, job.outFile, (p) => {
      const now = Date.now();
      if (now - last < 400 && p.progress < 1) return;
      last = now;
      send({ event: "progress", progress: p.progress, rendered: p.renderedFrames, encoded: p.encodedFrames, stage: p.stitchStage });
    }, job.opts);
    send({ event: "done", result: await r.done });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    send({ event: "error", message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
