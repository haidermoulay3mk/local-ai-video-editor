// Voiceovers: Kokoro (local, free, Apache-2.0) in a short-lived Node worker; Windows' own voice as the fallback.
// One job at a time — speech synthesis is CPU and memory heavy on a laptop.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_HOME, ROOT } from "./config";

export const VOICES = {
  am_michael: "Michael — confident US male",
  am_fenrir: "Fenrir — deep US male",
  am_puck: "Puck — upbeat US male",
  af_heart: "Heart — warm US female",
  af_bella: "Bella — bright US female",
  af_nicole: "Nicole — soft US female",
  bm_george: "George — UK male",
  bf_emma: "Emma — UK female",
} as const;
export type VoiceId = keyof typeof VOICES;
export const DEFAULT_VOICE: VoiceId = "am_michael";

export type VoiceResult = { file: string; duration: number; engine: "kokoro" | "windows" };

let chain: Promise<unknown> = Promise.resolve();

export function synthesizeVoice(text: string, voice: VoiceId, speed: number, outFile: string): Promise<VoiceResult> {
  const run = async (): Promise<VoiceResult> => {
    const jobsDir = path.join(APP_HOME, "cache", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const jobFile = path.join(jobsDir, `tts-${crypto.randomUUID()}.json`);
    writeFileSync(jobFile, JSON.stringify({ text, voice, speed, outFile }));
    const proc = Bun.spawn(["node", "--import", "tsx", path.join(ROOT, "src", "server", "tts-worker.ts"), jobFile], {
      cwd: ROOT, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    rmSync(jobFile, { force: true });
    let result: VoiceResult | undefined;
    let error: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith("@@")) continue;
      const msg = JSON.parse(line.slice(2)) as { event: string; result?: VoiceResult; message?: string };
      if (msg.event === "done") result = msg.result;
      if (msg.event === "error") error = msg.message;
    }
    if (result && code === 0) return result;
    throw new Error(error ?? `voiceover failed (exit ${code}): ${stderr.slice(-400)}`);
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}
