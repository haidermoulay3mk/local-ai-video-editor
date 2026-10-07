import { describe, expect, test } from "bun:test";
import { duckFactor } from "../src/remotion/AudioLayer";
import { cleanTrack } from "../src/server/faces";
import { parseWhisper, repairTimings } from "../src/server/transcribe";
import { resolveGrade } from "../src/shared/catalog";
import { keywordLines } from "../src/remotion/templates";
import { analyzeSamples } from "../src/server/music";
import { synthesize } from "../src/server/music-gen";
import { splitForSpeech } from "../src/server/tts-worker";
import { autoFixOptions, fixFilterChain, lookAdvice, parseSignalstats, shakeFromMotions } from "../src/server/look";
import { applyHook, HookSchema, hookPreviewSeconds } from "../src/shared/hooks";
import { parseSpec } from "../src/shared/spec";
import { chatTimes, parseChat } from "../src/shared/chat";
import { compact } from "../src/remotion/template-kit";
import { pickPexelsFile } from "../src/server/stock";
import {
  cameraAt, clipAt, correctWords, faceAt, layoutClips, mapWords, paginateWords, placeSource, sourceToOutput, speechIntervals, speedRampClips, totalFrames, totalSeconds,
} from "../src/shared/timeline";

const spec3 = parseSpec({
  format: { preset: "short", width: 1080, height: 1920, fps: 30 },
  clips: [
    { id: "a", mediaId: "M", in: 0, out: 4 },
    { id: "b", mediaId: "N", in: 0, out: 3, transition: { type: "whip", duration: 0.4 } },
    { id: "c", mediaId: "M", in: 4, out: 8, speed: 2, transition: { type: "zoom", duration: 0.4 } },
  ],
});

describe("timeline layout", () => {
  test("transitions overlap clips and frame totals match Remotion", () => {
    const l = layoutClips(spec3);
    expect(l.map((x) => [x.startFrame, x.durationFrames, x.transitionFrames])).toEqual([
      [0, 120, 0],
      [108, 90, 12],
      [186, 60, 12],
    ]);
    expect(totalFrames(spec3)).toBe(246);
  });
  test("transition is clamped to half of the shorter neighbour", () => {
    const s = parseSpec({ clips: [{ id: "a", mediaId: "M", in: 0, out: 0.5 }, { id: "b", mediaId: "M", in: 1, out: 3, transition: { type: "fade", duration: 2 } }] });
    expect(layoutClips(s)[1]!.transitionFrames).toBe(7); // floor(15 / 2)
  });
  test("cut transitions do not overlap", () => {
    const s = parseSpec({ clips: [{ id: "a", mediaId: "M", in: 0, out: 1 }, { id: "b", mediaId: "M", in: 1, out: 2, transition: { type: "cut" } }] });
    expect(layoutClips(s)[1]!.startFrame).toBe(30);
  });
  test("overlays can extend the video", () => {
    const s = parseSpec({ overlays: [{ type: "text", id: "t", start: 0, end: 5, text: "hi" }] });
    expect(totalFrames(s)).toBe(150);
  });
  test("clipAt prefers the incoming clip during a transition and maps source times", () => {
    const l = layoutClips(spec3);
    expect(clipAt(l, 3.7)!.clip.id).toBe("b");
    expect(sourceToOutput(l, "M", 5)).toEqual([6.2 + 0.5]);
  });
});

describe("words and captions", () => {
  const analysis = {
    M: { words: [
      { text: "hello", start: 0.5, end: 0.9 },
      { text: "gonna", start: 1.0, end: 1.3 },
      { text: "world", start: 5.0, end: 5.4 }, // inside clip c (4..8, 2x speed)
    ] },
  };
  test("mapWords follows cuts and speed", () => {
    const w = mapWords(spec3, analysis, false);
    expect(w.map((x) => x.text)).toEqual(["hello", "gonna", "world"]);
    expect(w[2]!.start).toBeCloseTo(6.2 + 0.5, 5);
    expect(w[2]!.end).toBeCloseTo(6.2 + 0.7, 5);
  });
  test("corrections: replace, delete, phrase merge", () => {
    const base = [
      { text: "Jordn", start: 0, end: 1, clipId: "a" },
      { text: "um", start: 1, end: 1.2, clipId: "a" },
      { text: "is", start: 1.2, end: 1.4, clipId: "a" },
      { text: "gonna", start: 1.4, end: 1.6, clipId: "a" },
    ];
    const out = correctWords(base, [{ from: "jordn", to: "Jordan" }, { from: "um", to: "" }, { from: "is gonna", to: "will" }]);
    expect(out.map((x) => x.text)).toEqual(["Jordan", "will"]);
    expect(out[1]!.end).toBe(1.6);
  });
  test("corrections keep trailing punctuation so caption pages still break at sentence ends", () => {
    const base = [
      { text: "Jordn.", start: 0, end: 0.5, clipId: "a" },
      { text: "This", start: 2, end: 2.3, clipId: "a" },
    ];
    const fixed = correctWords(base, [{ from: "Jordn", to: "Jordan" }]);
    expect(fixed[0]!.text).toBe("Jordan.");
    expect(paginateWords(fixed, 3).length).toBe(2);
  });
  test("pagination breaks on word count, gaps and sentence ends", () => {
    const w = ["one", "two", "three.", "four", "five", "six", "seven"].map((text, i) => ({
      text, start: i < 5 ? i * 0.3 : 5 + i * 0.3, end: (i < 5 ? i * 0.3 : 5 + i * 0.3) + 0.25, clipId: "a",
    }));
    const pages = paginateWords(w, 3);
    expect(pages.map((p) => p.words.map((x) => x.text).join(" "))).toEqual(["one two three.", "four five", "six seven"]);
  });
  test("a hook's cold open never shares a caption page with the video after it", () => {
    const w = [["laptop", "hook-c"], ["for", "hook-c"], ["most", "a"], ["people", "a"]].map(([text, clipId], i) => ({
      text: text!, start: i * 0.3, end: i * 0.3 + 0.25, clipId: clipId!,
    }));
    expect(paginateWords(w, 3).map((p) => p.words.map((x) => x.text).join(" "))).toEqual(["laptop for", "most people"]);
  });
  test("speech intervals merge close words", () => {
    const iv = speechIntervals([
      { text: "a", start: 0, end: 0.5, clipId: "x" },
      { text: "b", start: 0.7, end: 1, clipId: "x" },
      { text: "c", start: 3, end: 3.4, clipId: "x" },
    ]);
    expect(iv).toEqual([[0, 1], [3, 3.4]]);
  });
});

describe("whisper parsing", () => {
  test("uses DTW onsets, glues punctuation, drops noise tags, bounds word ends", () => {
    const tok = (text: string, dtw: number, from: number, to: number) => ({ text, t_dtw: dtw, offsets: { from, to } });
    const json = {
      result: { language: "en" },
      transcription: [
        { text: "", offsets: { from: 0, to: 150 }, tokens: [tok("[_BEG_]", -1, 0, 0)] },
        { text: " Hello", offsets: { from: 150, to: 600 }, tokens: [tok(" Hello", 30, 150, 600)] },
        { text: ",", offsets: { from: 600, to: 650 }, tokens: [tok(",", 60, 600, 650)] },
        { text: " [MUSIC]", offsets: { from: 700, to: 900 }, tokens: [tok(" [MUSIC]", 70, 700, 900)] },
        // segment offsets drift into the pause; the DTW onset (4.5 s) is the truth
        { text: " This", offsets: { from: 2240, to: 3050 }, tokens: [tok(" This", 450, 2380, 2640)] },
        { text: " works", offsets: { from: 3050, to: 3460 }, tokens: [tok(" works", 480, 3050, 3460)] },
      ],
    };
    const { words, language } = parseWhisper(json);
    expect(language).toBe("en");
    expect(words.map((w) => w.text)).toEqual(["Hello,", "This", "works"]);
    expect(words[0]!.start).toBeCloseTo(0.3);
    expect(words[0]!.end).toBeLessThan(1.2); // does not run through the pause until "This"
    expect(words[1]!.start).toBeCloseTo(4.5);
    expect(words[1]!.end).toBeCloseTo(4.8); // ends where the next word starts
    expect(words[2]!.end).toBeGreaterThan(words[2]!.start);
  });
});

describe("faces, framing, audio, grade", () => {
  test("cleanTrack fills short gaps but keeps long ones empty", () => {
    const s = (x: number) => [x, 0.5, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
    const out = cleanTrack([s(0.2), null, s(0.4), null, null, null, null, s(0.8)], 3, 1);
    expect(out[1]![0]).toBeCloseTo(0.3);
    expect(out[3]).toBeNull();
  });
  test("faceAt interpolates between samples", () => {
    const f = faceAt({ sampleFps: 5, samples: [[0.2, 0.5, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0], [0.4, 0.5, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0]] }, 0.1);
    expect(f!.cx).toBeCloseTo(0.3);
  });
  test("auto reframe: 16:9 into 9:16 follows the face and never shows empty canvas", () => {
    const p = placeSource({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { mode: "auto", zoom: 1, offsetX: 0, offsetY: 0 }, { x: 0.9, y: 0.4 });
    expect(p.mode).toBe("face");
    expect(p.left).toBeLessThanOrEqual(0);
    expect(p.left + p.width).toBeGreaterThanOrEqual(1080 - 1e-6);
    expect(p.height).toBeCloseTo(1920);
  });
  test("auto reframe without a face falls back to blurred fit", () => {
    expect(placeSource({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { mode: "auto", zoom: 1, offsetX: 0, offsetY: 0 }, null).mode).toBe("blur");
  });
  test("music ducks under speech with attack/release ramps", () => {
    const iv: [number, number][] = [[2, 4]];
    expect(duckFactor(iv, 3, 0.3)).toBe(0.3);
    expect(duckFactor(iv, 10, 0.3)).toBe(1);
    const release = duckFactor(iv, 4.25, 0.3);
    expect(release).toBeGreaterThan(0.3);
    expect(release).toBeLessThan(1);
  });
  test("grade presets stack with manual tweaks", () => {
    const g = resolveGrade({ ...parseSpec({}).grade, preset: "warm", temperature: 0.2, saturation: 1.5 });
    expect(g.temperature).toBeCloseTo(0.5);
    expect(g.saturation).toBeCloseTo(1.08 * 1.5);
  });
  test("schema rejects bad input with a useful path", () => {
    const r = (() => { try { parseSpec({ clips: [{ id: "a", mediaId: "M", in: 0, out: 1, speed: 9 }] }); return null; } catch (e) { return String(e); } })();
    expect(r).toContain("speed");
  });
});

describe("timing repair", () => {
  // Real case from ingest: DTW put "testing my video editor." all at 5.80 s, inside a 3.44–5.82 s silence,
  // while the phrase was actually spoken between the pauses (2.06–3.44 s).
  const words = [
    { text: "Haydhar,", start: 1.26, end: 1.87 },
    { text: "testing", start: 5.8, end: 5.86 },
    { text: "my", start: 5.8, end: 5.86 },
    { text: "video", start: 5.8, end: 5.86 },
    { text: "editor.", start: 5.8, end: 5.88 },
    { text: "This", start: 5.88, end: 6.3 },
  ];
  const silences = [{ start: 1.63, end: 2.06 }, { start: 3.44, end: 5.82 }];
  test("collapsed DTW runs are spread over the real speech between neighbours", () => {
    const out = repairTimings(words, silences);
    const [, testing, my, video, editor, thisWord] = out;
    expect(testing!.start).toBeGreaterThanOrEqual(2.0);
    expect(testing!.start).toBeLessThan(2.3);
    expect(editor!.end).toBeLessThanOrEqual(3.5);
    expect(my!.start).toBeGreaterThan(testing!.start);
    expect(video!.start).toBeGreaterThan(my!.start);
    expect(thisWord!.start).toBe(5.88); // reliable words are untouched
  });
  test("clean timings pass through unchanged", () => {
    const clean = [
      { text: "a", start: 0.1, end: 0.3 },
      { text: "b", start: 0.4, end: 0.6 },
    ];
    expect(repairTimings(clean, [{ start: 1, end: 2 }])).toEqual(clean);
  });
});

describe("hooks", () => {
  const base = parseSpec({
    format: { preset: "short", width: 1080, height: 1920, fps: 30 },
    clips: [{ id: "a", mediaId: "M", in: 10, out: 20 }],
    overlays: [{ id: "t1", type: "text", text: "Hi", start: 2, end: 4 }],
    effects: [{ id: "z1", type: "zoom", start: 1, end: 2 }],
    captions: { enabled: true, hide: [{ start: 5, end: 6 }], emphasis: [{ at: 3 }] },
    audio: {
      sfx: [{ id: "s1", sound: "pop", at: 2 }],
      music: [{ id: "m1", mediaId: "MU", start: 0 }, { id: "m2", mediaId: "MU", start: 5, end: 8 }],
    },
  });
  const coldOpen = HookSchema.parse({
    id: "h1", title: "Cold open", pattern: "cold_open", why: "payoff first", score: 8,
    prepend: [{ id: "c", mediaId: "M", in: 15, out: 17.5 }],
    overlays: [{ id: "k", type: "text", text: "WAIT FOR IT", start: 0, end: 1.5 }],
    hideCaptionsUntil: 1.5,
  });
  const titleOnly = HookSchema.parse({
    id: "h2", title: "Bold claim", pattern: "bold_claim", why: "big promise", score: 7,
    overlays: [{ id: "k", type: "text", text: "I QUIT SUGAR", start: 0, end: 2.5 }],
  });

  test("a cold open is prepended and every later layer shifts with the original footage", () => {
    const out = applyHook(base, coldOpen);
    expect(out.clips.map((c) => c.id)).toEqual(["hook-c", "a"]);
    expect(totalSeconds(out)).toBeCloseTo(12.5, 3);
    expect(out.overlays.find((o) => o.id === "t1")).toMatchObject({ start: 4.5, end: 6.5 });
    expect(out.overlays.find((o) => o.id === "hook-k")).toMatchObject({ start: 0, end: 1.5 });
    expect(out.effects[0]).toMatchObject({ id: "z1", start: 3.5, end: 4.5 });
    expect(out.audio.sfx[0]!.at).toBe(4.5);
    // music that opens the video keeps covering the new opening; later music moves with its moment
    expect(out.audio.music.map((m) => [m.start, m.end])).toEqual([[0, undefined], [7.5, 10.5]]);
    expect(out.captions.hide).toEqual([{ start: 7.5, end: 8.5 }, { start: 0, end: 1.5 }]);
    expect(out.captions.emphasis[0]!.at).toBe(5.5);
  });

  test("graphics-only hooks leave the timing alone", () => {
    const out = applyHook(base, titleOnly);
    expect(out.clips.map((c) => c.id)).toEqual(["a"]);
    expect(out.overlays.map((o) => [o.id, o.start, o.end])).toEqual([["t1", 2, 4], ["hook-k", 0, 2.5]]);
  });

  test("applying is pure, so choosing another hook swaps instead of stacking", () => {
    const before = JSON.stringify(base);
    const a = applyHook(base, coldOpen);
    expect(JSON.stringify(base)).toBe(before);
    expect(applyHook(base, coldOpen)).toEqual(a);
    expect(applyHook(base, titleOnly).clips.length).toBe(1);
  });

  test("preview window covers the hook plus a beat of the edit (4-9 s)", () => {
    expect(hookPreviewSeconds(base, coldOpen)).toBe(4.5); // 2.5 s cold open + 2
    expect(hookPreviewSeconds(base, titleOnly)).toBe(4.5); // title until 2.5 + 2
    const long = HookSchema.parse({ ...titleOnly, overlays: [{ id: "k", type: "text", text: "X", start: 0, end: 9 }] });
    expect(hookPreviewSeconds(base, long)).toBe(9);
  });

  test("schema rejects hooks without a reason or with an out-of-range score", () => {
    expect(HookSchema.safeParse({ ...titleOnly, why: "" }).success).toBe(false);
    expect(HookSchema.safeParse({ ...titleOnly, score: 11 }).success).toBe(false);
    expect(HookSchema.safeParse({ ...titleOnly, id: "../evil" }).success).toBe(false); // ids become file names
  });
});

describe("keyword slam", () => {
  test("long phrases split into two balanced lines; short ones stay on one", () => {
    expect(keywordLines("STUDYING WRONG?")).toEqual(["STUDYING", "WRONG?"]);
    expect(keywordLines("I QUIT SUGAR FOR 30 DAYS")).toEqual(["I QUIT SUGAR", "FOR 30 DAYS"]);
    expect(keywordLines("FREE?")).toEqual(["FREE?"]);
    expect(keywordLines("STOP NOW")).toEqual(["STOP NOW"]);
  });
});

describe("music library analysis + original beats", () => {
  const down4 = (x: Float32Array) => {
    const d = new Float32Array(Math.floor(x.length / 4));
    for (let i = 0; i < d.length; i++) d[i] = (x[4 * i]! + x[4 * i + 1]! + x[4 * i + 2]! + x[4 * i + 3]!) / 4;
    return d;
  };
  test("generated beats are deterministic per seed and well-formed", () => {
    const a = synthesize("phonk", { bpm: 128, seconds: 20, seed: 4 });
    const b = synthesize("phonk", { bpm: 128, seconds: 20, seed: 4 });
    expect(a.samples.length).toBe(b.samples.length);
    expect(a.samples[12345]).toBe(b.samples[12345]!);
    expect(a.beats[1]).toBeCloseTo(60 / 128, 3);
    expect(a.drops[0]).toBeCloseTo((4 * 4 * 60) / 128, 2); // first drop after the 4-bar intro
    expect(Math.max(...a.samples.subarray(0, 44100 * 5).map(Math.abs))).toBeLessThanOrEqual(0.9);
  });
  test.each([["phonk", 128], ["upbeat", 122], ["lofi", 82], ["cinematic", 110]] as const)(
    "%s at %d BPM: analysis lands on the beat grid (octave-equivalent) and finds the drop",
    (style, bpm) => {
      const g = synthesize(style, { bpm, seconds: 40, seed: 5 });
      const a = analyzeSamples(down4(g.samples), 11025);
      expect([1, 0.5, 2].some((m) => Math.abs(a.bpm! - bpm * m) <= 1.5)).toBe(true);
      const beat = 60 / bpm;
      const off = a.beats[0]! % beat;
      expect(Math.min(off, beat - off)).toBeLessThan(0.06);
      expect(Math.abs(a.drops[0]! - g.drops[0]!)).toBeLessThan(0.75);
    },
  );
});

describe("voiceover tracks", () => {
  const spec = parseSpec({
    format: { preset: "youtube", width: 1920, height: 1080, fps: 30 },
    clips: [{ id: "a", mediaId: "V", in: 0, out: 5 }],
    audio: { voice: [{ id: "vo1", mediaId: "VO", start: 3, offset: 1, end: 12 }] },
  });
  const analysis = { VO: { words: [{ text: "skipped", start: 0.2, end: 0.6 }, { text: "hello", start: 1.2, end: 1.6 }, { text: "late", start: 11, end: 11.4 }] } };
  test("voiceover words become output-time caption words (offset applied, end respected)", () => {
    const w = mapWords(spec, analysis).filter((x) => x.clipId === "voice:vo1");
    expect(w.map((x) => [x.text, Number(x.start.toFixed(2))])).toEqual([["hello", 3.2]]);
  });
  test("the video lasts until the voiceover ends", () => {
    expect(totalSeconds(spec)).toBeCloseTo(12, 3);
  });
  test("speech splitter keeps sentences whole and breathes between paragraphs", () => {
    const parts = splitForSpeech("One. Two? Three!\n\nNew paragraph here.");
    expect(parts.map((p) => p.text)).toEqual(["One.", "Two?", "Three!", "New paragraph here."]);
    expect(parts[2]!.pause).toBeGreaterThan(parts[0]!.pause);
  });
});

describe("footage health (look)", () => {
  const stat = (y: number, low: number, high: number, u: number, v: number, sat: number) =>
    `lavfi.signalstats.YAVG=${y}\nlavfi.signalstats.YLOW=${low}\nlavfi.signalstats.YHIGH=${high}\nlavfi.signalstats.UAVG=${u}\nlavfi.signalstats.VAVG=${v}\nlavfi.signalstats.SATAVG=${sat}\n`;

  test("signalstats lines are averaged across frames", () => {
    const s = parseSignalstats(stat(80, 20, 140, 120, 140, 20) + stat(100, 30, 160, 124, 136, 24));
    expect(s).toEqual({ y: 90, low: 25, high: 150, u: 122, v: 138, sat: 22 });
    expect(parseSignalstats("nothing here")).toBeNull();
  });

  test("shake = jitter around the smooth camera path; a steady pan is not shake", () => {
    const pan = Array.from({ length: 60 }, (_, i) => `0 3 0 0 0 0`).join("\n");
    const jitter = Array.from({ length: 60 }, (_, i) => `0 ${i % 2 ? 8 : -8} ${i % 3 ? 5 : -5} 0 0 0`).join("\n");
    expect(shakeFromMotions(`# header\n${pan}`, 320)).toBe(0);
    expect(shakeFromMotions(jitter, 320)).toBeGreaterThan(1);
  });

  test("advice: dark + shaky gets fixed; a warm but well-exposed shot keeps its colours", () => {
    const dark = lookAdvice({ y: 70, low: 20, high: 130, u: 117, v: 148, sat: 22 }, 2.4);
    expect(dark.advice.stabilize).toBe(true);
    expect(dark.advice.color!.gamma).toBeGreaterThan(1.2);
    expect(dark.advice.whiteBalance?.strong).toBe(false); // moderate tint: suggestion only
    expect(autoFixOptions(dark)).toEqual({ stabilize: true, denoise: true, color: true, whiteBalance: false });
    const warm = lookAdvice({ y: 115, low: 30, high: 210, u: 118, v: 141, sat: 25 }, 0);
    expect(autoFixOptions(warm)).toBeNull();
    const tungsten = lookAdvice({ y: 115, low: 30, high: 210, u: 104, v: 150, sat: 25 }, 0);
    expect(tungsten.advice.whiteBalance?.strong).toBe(true);
    expect(autoFixOptions(tungsten)?.whiteBalance).toBe(true);
  });

  test("filter chain contains exactly the requested fixes", () => {
    const dark = lookAdvice({ y: 70, low: 20, high: 130, u: 117, v: 148, sat: 22 }, 2.4);
    const chain = fixFilterChain(dark, { stabilize: true, color: true });
    expect(chain).toContain("vidstabtransform=input=fix.trf");
    expect(chain).toContain(`eq=gamma=${dark.advice.color!.gamma}`);
    expect(chain).not.toContain("hqdn3d");
    expect(chain).not.toContain("lutyuv");
    expect(fixFilterChain(dark, { whiteBalance: true })).toContain("lutyuv=u=val-(");
  });
});

describe("motion: camera moves + speed ramps", () => {
  const canvas = { width: 1080, height: 1920 };
  test("push / punch zoom toward the face; photos push in by default; video without motion stays still", () => {
    const face = { x: 540, y: 700 };
    expect(cameraAt({ type: "pushIn", amount: 0.1 }, "video", 0, canvas, face)!.scale).toBeCloseTo(1, 5);
    expect(cameraAt({ type: "pushIn", amount: 0.1 }, "video", 1, canvas, face)!.scale).toBeCloseTo(1.1, 5);
    expect(cameraAt({ type: "pullOut", amount: 0.1 }, "video", 1, canvas, face)!.scale).toBeCloseTo(1, 5);
    const punch = cameraAt({ type: "punch", amount: 0.12 }, "video", 0.5, canvas, face)!;
    expect([punch.scale, punch.originX, punch.originY]).toEqual([1.12, 540, 700]);
    expect(cameraAt(undefined, "image", 1, canvas, null)!.scale).toBeCloseTo(1.06, 5);
    expect(cameraAt(undefined, "video", 1, canvas, null)).toBeNull();
  });

  test("pans never reveal the canvas edge", () => {
    for (const type of ["panLeft", "panRight", "panUp", "panDown"] as const) {
      for (const t of [0, 0.5, 1]) {
        const c = cameraAt({ type, amount: 0.15 }, "video", t, canvas, null)!;
        expect(Math.abs(c.tx)).toBeLessThanOrEqual(((c.scale - 1) * canvas.width) / 2);
        expect(Math.abs(c.ty)).toBeLessThanOrEqual(((c.scale - 1) * canvas.height) / 2);
      }
    }
  });

  test("speed ramp splits the source evenly, speeds follow the curve, transition stays on the first slice", () => {
    const clip = parseSpec({ clips: [{ id: "b", mediaId: "M", in: 2, out: 8, transition: { type: "whip" } }] }).clips[0]!;
    const segs = speedRampClips(clip, 3, "upDown", 6);
    expect(segs).toHaveLength(6);
    expect(segs[0]!.in).toBe(2);
    expect(segs[5]!.out).toBe(8);
    expect(segs.every((s, i) => i === 0 || s.in === segs[i - 1]!.out)).toBe(true);
    expect(segs[0]!.speed).toBeLessThan(segs[2]!.speed);
    expect(segs[5]!.speed).toBeLessThan(segs[3]!.speed);
    expect(segs[0]!.transition?.type).toBe("whip");
    expect(segs[1]!.transition).toBeUndefined();
    const slow = speedRampClips(clip, 0.4, "down", 4);
    expect(slow[0]!.speed).toBeLessThan(slow[3]!.speed);
  });
});

describe("faceless formats", () => {
  test("chat: me on the right, names on the left, 'them' anonymous, blank lines dropped", () => {
    const m = parseChat(["me: hey|Sam: what?", "them: who", "", "plain line|I: ok"].join("\n"));
    expect(m.map((x) => [x.me, x.who, x.text])).toEqual([
      [true, "", "hey"], [false, "Sam", "what?"], [false, "", "who"], [false, "", "plain line"], [true, "", "ok"],
    ]);
  });
  test("chat timing: spread over the layer, at least 0.6 s apart, or a fixed pace", () => {
    const msgs = parseChat("me: a|me: b|me: c|me: d");
    expect(chatTimes(msgs, 10)[0]).toBeCloseTo(0.35, 5);
    expect(chatTimes(msgs, 10)[1]! - chatTimes(msgs, 10)[0]!).toBeCloseTo(2.3, 5);
    expect(chatTimes(msgs, 1)[1]! - chatTimes(msgs, 1)[0]!).toBeCloseTo(0.6, 5);
    expect(chatTimes(msgs, 10, 0.4)[3]).toBeCloseTo(0.35 + 1.2, 5);
  });
  test("compact numbers for social counters", () => {
    expect([compact(842), compact(12500), compact(480000), compact(1200000), compact(12000000)]).toEqual(["842", "12.5K", "480K", "1.2M", "12M"]);
  });
  test("photos crop-to-fill when the crop is modest; video keeps blur/face", () => {
    const rf = { mode: "auto" as const, zoom: 1, offsetX: 0, offsetY: 0 };
    const short = { width: 1080, height: 1920 };
    expect(placeSource({ width: 960, height: 1410, kind: "image" }, short, rf, null).mode).toBe("fill"); // 17% crop
    expect(placeSource({ width: 1536, height: 2048, kind: "image" }, short, rf, null).mode).toBe("fill"); // 3:4 phone photo
    expect(placeSource({ width: 1080, height: 1080, kind: "image" }, short, rf, null).mode).toBe("blur"); // square: too much
    expect(placeSource({ width: 960, height: 1410, kind: "video" }, short, rf, null).mode).toBe("blur");
  });
  test("layout + brand default off / empty and validate", () => {
    const s = parseSpec({});
    expect(s.layout.mode).toBe("full");
    expect(s.brand.colors).toEqual([]);
    const sp = parseSpec({ layout: { mode: "split", mediaId: "G" }, brand: { handle: "@me", avatar: "AV" } });
    expect([sp.layout.ratio, sp.layout.fillerPosition, sp.layout.fillerVolume]).toEqual([0.5, "bottom", 0]);
    expect(() => parseSpec({ layout: { mode: "split", ratio: 0.9 } })).toThrow();
  });
  test("pexels file pick prefers the smallest file that is still >= 1080p", () => {
    const f = (w: number, h: number) => ({ link: `${w}x${h}`, width: w, height: h, file_type: "video/mp4" });
    expect(pickPexelsFile([f(3840, 2160), f(1920, 1080), f(1280, 720)])?.link).toBe("1920x1080");
    expect(pickPexelsFile([f(1280, 720), f(640, 360)])?.link).toBe("1280x720");
    expect(pickPexelsFile([f(1080, 1920), f(2160, 3840)])?.link).toBe("1080x1920");
  });
});
