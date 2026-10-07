// Static file responses with HTTP Range support (browsers need it to seek in video).
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".json": "application/json", ".svg": "image/svg+xml",
};

export const contentType = (p: string) => TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream";

/** Resolve `rel` inside `root`, refusing anything that escapes it (path traversal). */
export function safeJoin(root: string, rel: string): string | null {
  const full = path.resolve(root, rel);
  const r = path.resolve(root) + path.sep;
  return full.startsWith(r) ? full : null;
}

export function serveFile(req: Request, file: string, extraHeaders: Record<string, string> = {}): Response {
  if (!existsSync(file)) return new Response("Not found", { status: 404 });
  const size = statSync(file).size;
  const headers: Record<string, string> = {
    "Content-Type": contentType(file),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  };
  const range = req.headers.get("range");
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    let start = m[1] ? Number(m[1]) : NaN;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (Number.isNaN(start)) {
      start = Math.max(0, size - end); // suffix range: last N bytes
      end = size - 1;
    }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    return new Response(Bun.file(file).slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(Bun.file(file), { headers: { ...headers, "Content-Length": String(size) } });
}

/** Stream a body to disk chunk by chunk (never buffers the whole file), failing past `limit` bytes. */
export async function streamToFile(body: ReadableStream<Uint8Array>, file: string, limit: number): Promise<number> {
  const writer = Bun.file(file).writer();
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > limit) throw new Error(`file is larger than ${(limit / 1024 ** 3).toFixed(0)} GB`);
      writer.write(chunk);
    }
  } finally {
    await writer.end();
  }
  return size;
}
