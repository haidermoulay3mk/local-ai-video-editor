// Dev check: render one frame of every hook of a project (with the CURRENT templates) into a contact sheet.
// Usage (server running): bun scripts/hook-sheet.ts <projectId> [seconds=0.9]
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyHook } from "../src/shared/hooks";
import { ffmpegPath } from "../src/server/config";
import { renderStillsJob } from "../src/server/render-client";
import { compositionProps, getProject } from "../src/server/store";

const [id, at = "0.9"] = process.argv.slice(2);
const p = id ? getProject(id) : null;
if (!p?.hooks?.length) throw new Error("usage: bun scripts/hook-sheet.ts <projectId with hooks> [seconds]");
const out = path.join(os.tmpdir(), "video-editor-hook-sheet", p.id);
mkdirSync(out, { recursive: true });
const base = p.hookBase ?? p.spec;
const files: string[] = [];
for (const h of p.hooks) {
  const props = { ...compositionProps(p, true), spec: applyHook(base, h) };
  const [file] = await renderStillsJob(props, [Number(at)], path.join(out, h.id), 0.5).done;
  console.log(`${h.id} [${h.pattern}] ${h.title} → ${file}`);
  files.push(file!);
}
const sheet = path.join(out, "sheet.jpg");
const r = Bun.spawnSync([ffmpegPath(), "-v", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `hstack=inputs=${files.length}`, sheet]);
if (r.exitCode !== 0) throw new Error(r.stderr.toString());
console.log(`sheet: ${sheet}`);
