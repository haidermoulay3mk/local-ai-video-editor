// Free visuals for faceless videos: stock photos/videos and AI images, downloaded INTO the project as media.
//  - Openverse (no key): public-domain photos only (CC0 / Public Domain Mark) — free to use, no attribution needed.
//  - Pexels (free key): stock videos + photos under the Pexels license (free, attribution appreciated, not required).
//  - AI images: Hugging Face FLUX schnell (free token) or Pollinations (no key; small watermark without a free token).
// Only the search words / prompt are sent to these services — never footage or personal data.
import path from "node:path";
import { streamToFile } from "./files";
import { enqueueIngest } from "./ingest";
import { getKey } from "./keys";
import { getProject, mediaDir, type MediaRecord, newMediaRecord, type Project, saveProject } from "./store";

export type StockKind = "photo" | "video";
export type Orientation = "portrait" | "landscape" | "square";
export type StockHit = {
  provider: "openverse" | "pexels";
  kind: StockKind;
  id: string;
  download: string;
  width: number;
  height: number;
  duration?: number;
  title: string;
  creator?: string;
  license: string;
  page: string; // where the credit links to
};

const UA = { "User-Agent": "VideoEditor/1.0 (local desktop app)" };
const MAX_BYTES = 400 * 1024 ** 2;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(25_000) });
  if (res.status === 429) throw new Error("the stock service is rate-limiting us — wait a minute and try again");
  if (res.status === 401 || res.status === 403) throw new Error("the API key was rejected — check it in Settings → API keys");
  if (!res.ok) throw new Error(`stock search failed (HTTP ${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------- search

type OpenverseItem = { id: string; title?: string; url: string; creator?: string; license: string; foreign_landing_url?: string; width?: number | null; height?: number | null; mature?: boolean };

async function openversePhotos(query: string, orientation: Orientation, count: number): Promise<StockHit[]> {
  const aspect = { portrait: "tall", landscape: "wide", square: "square" }[orientation];
  const u = new URL("https://api.openverse.org/v1/images/");
  u.search = new URLSearchParams({ q: query, license: "cc0,pdm", aspect_ratio: aspect, size: "large", page_size: String(Math.min(20, count * 4)) }).toString();
  const data = (await getJson(u.toString())) as { results?: OpenverseItem[] };
  return (data.results ?? [])
    .filter((r) => !r.mature && /^https:\/\//.test(r.url) && /\.(jpe?g|png|webp)(\?|$)/i.test(r.url) && (r.width ?? 1200) >= 800)
    .slice(0, count)
    .map((r) => ({
      provider: "openverse" as const, kind: "photo" as const, id: r.id, download: r.url, width: r.width ?? 0, height: r.height ?? 0,
      title: r.title || query, creator: r.creator, license: r.license === "cc0" ? "CC0 (public domain)" : "Public Domain Mark",
      page: r.foreign_landing_url ?? r.url,
    }));
}

type PexelsFile = { link: string; width: number; height: number; file_type: string; quality?: string };
type PexelsVideo = { id: number; url: string; duration: number; width: number; height: number; user?: { name?: string }; video_files: PexelsFile[] };
type PexelsPhoto = { id: number; url: string; alt?: string; width: number; height: number; photographer?: string; src: Record<string, string> };

/** The smallest mp4 whose short side is at least 1080 (else the biggest) — sharp enough, not wastefully huge. */
export function pickPexelsFile(files: PexelsFile[]): PexelsFile | undefined {
  const mp4 = files.filter((f) => f.file_type === "video/mp4" && f.width && f.height);
  const short = (f: PexelsFile) => Math.min(f.width, f.height);
  const ok = mp4.filter((f) => short(f) >= 1080).sort((a, b) => short(a) - short(b));
  return ok[0] ?? mp4.sort((a, b) => short(b) - short(a))[0];
}

async function pexels(query: string, kind: StockKind, orientation: Orientation, count: number, key: string): Promise<StockHit[]> {
  const base = kind === "video" ? "https://api.pexels.com/videos/search" : "https://api.pexels.com/v1/search";
  const u = new URL(base);
  u.search = new URLSearchParams({ query, orientation, per_page: String(Math.min(30, count * 3)), ...(kind === "video" ? { size: "medium" } : {}) }).toString();
  const data = (await getJson(u.toString(), { Authorization: key })) as { videos?: PexelsVideo[]; photos?: PexelsPhoto[] };
  if (kind === "video") {
    return (data.videos ?? []).flatMap((v) => {
      const f = pickPexelsFile(v.video_files);
      if (!f || v.duration < 3) return [];
      return [{ provider: "pexels" as const, kind, id: String(v.id), download: f.link, width: f.width, height: f.height, duration: v.duration, title: query, creator: v.user?.name, license: "Pexels License", page: v.url }];
    }).slice(0, count);
  }
  return (data.photos ?? []).slice(0, count).map((ph) => ({
    provider: "pexels" as const, kind, id: String(ph.id),
    download: `${ph.src.original}?auto=compress&cs=tinysrgb&${orientation === "portrait" ? "h=1920" : "w=1920"}`,
    width: ph.width, height: ph.height, title: ph.alt || query, creator: ph.photographer, license: "Pexels License", page: ph.url,
  }));
}

export async function searchStock(query: string, kind: StockKind, orientation: Orientation, count: number): Promise<StockHit[]> {
  const q = query.trim().slice(0, 100);
  if (!q) throw new Error("query is empty");
  const key = getKey("pexels");
  if (kind === "video") {
    if (!key) throw new Error("stock VIDEO needs a free Pexels API key (Settings → API keys). Photos work without one.");
    return pexels(q, kind, orientation, count, key);
  }
  if (key) {
    const hits = await pexels(q, kind, orientation, count, key).catch(() => []);
    if (hits.length) return hits;
  }
  return openversePhotos(q, orientation, count);
}

// ---------------------------------------------------------------- add to the project

async function download(url: string, file: string, headers: Record<string, string> = {}): Promise<{ size: number; type: string }> {
  const res = await fetch(url, { headers: { ...UA, ...headers }, redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("file is too large");
  const type = res.headers.get("content-type") ?? "";
  // Not Bun.write(file, res): that hangs on some Windows paths; stream chunk by chunk instead.
  return { size: await streamToFile(res.body, file, MAX_BYTES), type };
}

async function addMedia(p: Project, name: string, ext: string, source: MediaRecord["source"], kind: MediaRecord["kind"], fetchInto: (file: string) => Promise<{ size: number; type: string }>) {
  const m = newMediaRecord(p.id, name, ext, source);
  m.kind = kind;
  const file = path.join(mediaDir(p.id, m.id), m.original);
  const r = await fetchInto(file);
  if (r.type && !/^(image|video)\//.test(r.type) && !/octet-stream/.test(r.type)) throw new Error(`expected an image/video, got ${r.type}`);
  if (r.size < 4000) throw new Error("the service returned an empty file");
  m.size = r.size;
  const fresh = getProject(p.id)!;
  fresh.media.push(m);
  saveProject(fresh);
  await enqueueIngest(fresh.id, m.id);
  const rec = getProject(p.id)!.media.find((x) => x.id === m.id)!;
  if (rec.steps.probe?.state !== "done") throw new Error(`downloaded file could not be read: ${rec.steps.probe?.error ?? "probe failed"}`);
  return rec;
}

export type AddedMedia = { mediaId: string; kind: string; width: number; height: number; duration: number; title: string; credit: string };

const credit = (h: { title: string; creator?: string; license: string; provider: string }) =>
  `${h.title}${h.creator ? ` by ${h.creator}` : ""} — ${h.license} (${h.provider})`;

const orientationOf = (p: Project): Orientation =>
  p.spec.format.height > p.spec.format.width ? "portrait" : p.spec.format.height === p.spec.format.width ? "square" : "landscape";

/** Search and download the top `count` results into the project. */
export async function findStock(p: Project, input: { query: string; kind?: StockKind; orientation?: Orientation; count?: number }): Promise<{ added: AddedMedia[]; errors: string[] }> {
  const kind = input.kind === "video" ? "video" : "photo";
  const count = Math.max(1, Math.min(6, input.count ?? 3));
  const hits = await searchStock(input.query, kind, input.orientation ?? orientationOf(p), count);
  if (!hits.length) return { added: [], errors: [`no ${kind}s found for "${input.query}" — try simpler words (e.g. "city night", "ocean waves")`] };
  const added: AddedMedia[] = [];
  const errors: string[] = [];
  for (const h of hits) {
    try {
      const ext = h.kind === "video" ? ".mp4" : (/\.(png|webp)(?=\?|$)/i.exec(h.download)?.[0] ?? ".jpg");
      const rec = await addMedia(p, `${h.kind === "video" ? "Stock video" : "Stock photo"} — ${h.title}`.slice(0, 110), ext,
        { type: "stock", provider: h.provider, url: h.page, license: h.license, creator: h.creator, title: h.title.slice(0, 120) },
        h.kind === "video" ? "video" : "image", (f) => download(h.download, f));
      added.push({ mediaId: rec.id, kind: rec.kind, width: rec.width, height: rec.height, duration: rec.duration, title: h.title, credit: credit(h) });
    } catch (e) {
      errors.push(`${h.provider} ${h.id}: ${(e as Error).message}`);
    }
  }
  return { added, errors };
}

// ---------------------------------------------------------------- AI images

const ASPECTS = { portrait: [768, 1344], landscape: [1344, 768], square: [1024, 1024] } as const;

/** Generate one AI image into the project. Hugging Face if a token is set (falls back), else Pollinations. */
export async function generateImage(p: Project, input: { prompt: string; orientation?: Orientation; seed?: number }): Promise<AddedMedia & { provider: string; watermark: boolean }> {
  const prompt = input.prompt.trim().slice(0, 600);
  if (!prompt) throw new Error("prompt is empty");
  const [w, h] = ASPECTS[input.orientation ?? orientationOf(p)];
  const seed = input.seed ?? Math.floor(Math.random() * 1e6);
  const name = `AI image — ${prompt}`.slice(0, 110);
  const hf = getKey("huggingface");
  const errors: string[] = [];
  if (hf) {
    try {
      const rec = await addMedia(p, name, ".jpg", { type: "ai", provider: "huggingface", prompt }, "image", async (file) => {
        const res = await fetch("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell", {
          method: "POST", signal: AbortSignal.timeout(120_000),
          headers: { Authorization: `Bearer ${hf}`, "Content-Type": "application/json", Accept: "image/jpeg" },
          body: JSON.stringify({ inputs: prompt, parameters: { width: w, height: h, num_inference_steps: 4, seed } }),
        });
        if (!res.ok || !res.body) throw new Error(`Hugging Face HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
        return { size: await streamToFile(res.body, file, MAX_BYTES), type: res.headers.get("content-type") ?? "image/jpeg" };
      });
      return { mediaId: rec.id, kind: "image", width: rec.width, height: rec.height, duration: 0, title: prompt, credit: "AI image (FLUX.1 schnell via Hugging Face)", provider: "huggingface", watermark: false };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const token = getKey("pollinations");
  const u = new URL(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`);
  u.search = new URLSearchParams({ width: String(w), height: String(h), seed: String(seed), nologo: "true", model: "flux" }).toString();
  try {
    const rec = await addMedia(p, name, ".jpg", { type: "ai", provider: "pollinations", prompt }, "image",
      (f) => download(u.toString(), f, token ? { Authorization: `Bearer ${token}` } : {}));
    return { mediaId: rec.id, kind: "image", width: rec.width, height: rec.height, duration: 0, title: prompt, credit: "AI image (Pollinations)", provider: "pollinations", watermark: !token };
  } catch (e) {
    throw new Error([...errors, `Pollinations: ${(e as Error).message}`].join("; "));
  }
}

/** Credit lines for stock media used in the edit (for the video description). */
export function stockCredits(p: Project): string[] {
  const used = new Set<string>([
    ...p.spec.clips.map((c) => c.mediaId),
    ...p.spec.overlays.flatMap((o) => ("mediaId" in o ? [o.mediaId] : o.type === "template" ? Object.values(o.props).map(String) : [])),
    ...(p.spec.layout.mediaId ? [p.spec.layout.mediaId] : []),
  ]);
  return p.media.flatMap((m) =>
    used.has(m.id) && m.source.type === "stock"
      ? [`${m.source.title}${m.source.creator ? ` by ${m.source.creator}` : ""} (${m.source.license}) ${m.source.url}`]
      : [],
  );
}
