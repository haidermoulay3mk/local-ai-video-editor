// Stock / AI-image gate (LIVE network): downloads public-domain photos (Openverse) and one AI image (Pollinations)
// into a throwaway project, checks they ingest, renders a still, checks the no-key video message, then cleans up.
// Usage: bun scripts/stock-test.ts
import path from "node:path";
import { APP_HOME, ffmpegPath } from "../src/server/config";
import { applySpec } from "../src/server/editor";
import { getKey } from "../src/server/keys";
import { renderStillsJob, warmBundle } from "../src/server/render-client";
import { findStock, generateImage, pickPexelsFile, stockCredits } from "../src/server/stock";
import { compositionProps, createProject, deleteProject, getProject, projectDir } from "../src/server/store";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  — ${info}` : ""}`);
  ok ? pass++ : fail++;
};

const p = createProject("stock gate (temporary)", "short");
try {
  const f = pickPexelsFile([
    { link: "a", width: 3840, height: 2160, file_type: "video/mp4" },
    { link: "b", width: 1920, height: 1080, file_type: "video/mp4" },
    { link: "c", width: 960, height: 540, file_type: "video/mp4" },
  ]);
  check("pexels file pick = smallest ≥1080p", f?.link === "b");

  const photos = await findStock(p, { query: "mountain sunrise", kind: "photo", count: 2 });
  check("public-domain photos downloaded", photos.added.length >= 1, `${photos.added.length} added; errors: ${photos.errors.join(" | ") || "none"}`);
  const ph = photos.added[0];
  check("photo ingested with size", !!ph && ph.kind === "image" && ph.width > 0 && ph.height > 0, ph ? `${ph.width}x${ph.height} ${ph.credit}` : "");

  const ai = await generateImage(p, { prompt: "cinematic photo of a lighthouse on a cliff at golden hour, dramatic clouds", seed: 7 });
  check("AI image generated", ai.kind === "image" && ai.width > 0, `${ai.provider} ${ai.width}x${ai.height} watermark=${ai.watermark}`);

  if (!getKey("pexels")) {
    const msg = await findStock(p, { query: "ocean", kind: "video" }).then(() => "no error", (e: Error) => e.message);
    check("stock video without a key explains the free Pexels key", /Pexels/.test(msg), msg);
  }

  // Use them in an edit: photo (default push-in) then the AI image.
  const cur = getProject(p.id)!;
  const clips = [ph, ai].filter(Boolean).map((m, i) => ({ id: `s${i}`, mediaId: m!.mediaId, in: 0, out: 2.5, transition: i ? { type: "zoomPunch", duration: 0.4 } : undefined }));
  const r = applySpec(cur, { ...cur.spec, clips }, "stock gate");
  check("edit with stock + AI clips validates", r.ok, r.errors.join("; "));
  const credits = stockCredits(getProject(p.id)!);
  check("credits list the stock photo + licence", credits.length >= 1 && /CC0|Public Domain|Pexels/.test(credits[0] ?? ""), credits[0] ?? "");

  await warmBundle().done;
  const stills = await renderStillsJob(compositionProps(getProject(p.id)!, false), [0.4, 3.2], path.join(projectDir(p.id), "gate-stills"), 0.4).done;
  check("stills render", stills.length === 2);
  const out = path.join(APP_HOME, "test", "stock-sheet.jpg");
  Bun.spawnSync([ffmpegPath(), "-y", "-loglevel", "error", "-i", stills[0]!, "-i", stills[1]!, "-filter_complex", "[0:v][1:v]hstack=inputs=2", out]);
  console.log(`sheet: ${out}`);
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  deleteProject(p.id);
}
console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
