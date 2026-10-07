// One-time setup: downloads the free local tools the Video Editor needs into ./tools.
// Everything here is open source and free; nothing requires an account or API key.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { installWhisperCpp } from "@remotion/install-whisper-cpp";
import {
  TOOLS, WHISPER_MODEL, WHISPER_MODEL_BYTES, WHISPER_VERSION, whisperExePath, whisperModelPath,
} from "../src/server/config";

const FFMPEG_ZIP = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"; // GPL build, free
const YUNET_URL =
  "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2026may.onnx"; // MIT

async function download(url: string, dest: string) {
  console.log(`  downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  await Bun.write(dest, res);
}

async function setupFfmpeg() {
  if (existsSync(TOOLS.ffmpeg) && existsSync(TOOLS.ffprobe)) return console.log("ffmpeg: ok");
  console.log("ffmpeg: installing (full build for analysis + voice enhance)...");
  const tmp = path.join(TOOLS.root, "ffmpeg.zip");
  const extractDir = path.join(TOOLS.root, "ffmpeg-extract");
  mkdirSync(extractDir, { recursive: true });
  if (!existsSync(tmp)) await download(FFMPEG_ZIP, tmp);
  // Windows 10+ ships bsdtar (System32\tar.exe), which extracts zip files. Use the full path:
  // a Git-for-Windows GNU tar earlier on PATH would misread "C:" as a remote host.
  const winTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const tar = Bun.spawnSync([existsSync(winTar) ? winTar : "tar", "-xf", tmp, "-C", extractDir]);
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  const inner = readdirSync(extractDir).find((d) => d.startsWith("ffmpeg"));
  if (!inner) throw new Error("ffmpeg archive layout unexpected");
  rmSync(path.dirname(TOOLS.ffmpeg), { recursive: true, force: true });
  mkdirSync(path.dirname(path.dirname(TOOLS.ffmpeg)), { recursive: true });
  renameSync(path.join(extractDir, inner, "bin"), path.dirname(TOOLS.ffmpeg));
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(tmp, { force: true });
  console.log("ffmpeg: ok");
}

async function setupWhisper() {
  if (!existsSync(whisperExePath())) {
    await installWhisperCpp({ version: WHISPER_VERSION, to: TOOLS.whisper, printOutput: true });
  }
  // Own downloader (size-checked) — the library's stream writer proved unreliable under Bun.
  const modelFile = whisperModelPath();
  const expected = WHISPER_MODEL_BYTES[WHISPER_MODEL];
  if (!existsSync(modelFile) || (expected && statSync(modelFile).size !== expected)) {
    mkdirSync(TOOLS.models, { recursive: true });
    await download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin`, modelFile);
    const size = statSync(modelFile).size;
    if (expected && size !== expected) throw new Error(`Whisper model size ${size} != expected ${expected}`);
  }
  if (!existsSync(whisperExePath())) throw new Error(`whisper-cli.exe not found under ${TOOLS.whisper}`);
  console.log("whisper.cpp + model: ok");
}

async function setupFaceModel() {
  if (existsSync(TOOLS.faceModel)) return console.log("face model: ok");
  mkdirSync(TOOLS.models, { recursive: true });
  await download(YUNET_URL, TOOLS.faceModel);
  console.log("face model: ok");
}

mkdirSync(TOOLS.root, { recursive: true });
await setupFfmpeg();
await setupWhisper();
await setupFaceModel();
console.log("\nSetup complete. Run `bun start` and open http://localhost:4600");
