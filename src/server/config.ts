import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runtime-agnostic (this file is also loaded by the Node render worker, not just Bun).
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PORT = Number(process.env.VIDEO_EDITOR_PORT ?? 4600);
export const HOST = "127.0.0.1"; // local only — never exposed to the network

// Heavy files (tools, models, your videos, renders) live OUTSIDE the repo on purpose: the repo may sit in a
// cloud-synced folder (OneDrive, Dropbox…), and syncing gigabytes of video would eat the quota and upload private
// footage. %LOCALAPPDATA% is never synced. Override with VIDEO_EDITOR_HOME.
export const APP_HOME =
  process.env.VIDEO_EDITOR_HOME ??
  path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? ROOT, "AppData", "Local"), "Video Editor");
export const DATA_DIR = path.join(APP_HOME, "data");
export const PROJECTS_DIR = path.join(DATA_DIR, "projects");

export const WHISPER_VERSION = "1.8.4";
// Multilingual (English + Arabic). "small" is more accurate but ~3x slower on CPU.
export const WHISPER_MODEL = (process.env.VIDEO_EDITOR_WHISPER_MODEL ?? "base") as "base" | "small" | "medium";
export const WHISPER_MODEL_BYTES: Record<string, number> = {
  base: 147951465, small: 487601967, medium: 1533763059,
};

const toolsRoot = path.join(APP_HOME, "tools");
export const TOOLS = {
  root: toolsRoot,
  ffmpeg: path.join(toolsRoot, "ffmpeg", "bin", "ffmpeg.exe"),
  ffprobe: path.join(toolsRoot, "ffmpeg", "bin", "ffprobe.exe"),
  whisper: path.join(toolsRoot, "whisper"),
  models: path.join(toolsRoot, "models"),
  faceModel: path.join(toolsRoot, "models", "face_detection_yunet_2026may.onnx"),
};

export function whisperModelPath(model = WHISPER_MODEL) {
  return path.join(TOOLS.models, `ggml-${model}.bin`);
}

/** whisper.cpp release zips unpack to Release/ (Windows) or build/bin/ depending on version. */
export function whisperExePath() {
  for (const dir of [["Release"], ["build", "bin"], []]) {
    const p = path.join(TOOLS.whisper, ...dir, "whisper-cli.exe");
    if (existsSync(p)) return p;
  }
  return path.join(TOOLS.whisper, "Release", "whisper-cli.exe");
}

// Remotion ships a minimal ffmpeg; used as a fallback when setup hasn't run yet.
const remotionBin = path.join(ROOT, "node_modules", "@remotion", "compositor-win32-x64-msvc");
export function ffmpegPath() {
  return existsSync(TOOLS.ffmpeg) ? TOOLS.ffmpeg : path.join(remotionBin, "ffmpeg.exe");
}
export function ffprobePath() {
  return existsSync(TOOLS.ffprobe) ? TOOLS.ffprobe : path.join(remotionBin, "ffprobe.exe");
}

export const FREE_LIMITS = {
  // Autopilot keeps Claude working while it reports status "working", up to this many extra turns.
  autopilotMaxTurns: 6,
};
