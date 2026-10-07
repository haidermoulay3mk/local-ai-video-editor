// Optional free API keys (stock footage / AI images). Stored ONLY on this PC in %LOCALAPPDATA%\Video Editor\keys.json
// (outside the repo and any synced folder) or taken from environment variables. Each key is sent only to its own service.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_HOME } from "./config";

export const KEY_NAMES = ["pexels", "pollinations", "huggingface"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export const KEY_INFO: Record<KeyName, { env: string; what: string; getAt: string }> = {
  pexels: { env: "PEXELS_API_KEY", what: "stock VIDEO B-roll + more photos (free, no attribution needed)", getAt: "https://www.pexels.com/api/ (free account → 'Your API key')" },
  pollinations: { env: "POLLINATIONS_TOKEN", what: "AI images without the small pollinations.ai watermark (free account)", getAt: "https://auth.pollinations.ai" },
  huggingface: { env: "HF_TOKEN", what: "AI images via Hugging Face (FLUX schnell) — free tier has a small monthly allowance", getAt: "https://huggingface.co/settings/tokens (read token)" },
};

const FILE = path.join(APP_HOME, "keys.json");

function readFile(): Partial<Record<KeyName, string>> {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Partial<Record<KeyName, string>>) : {};
  } catch {
    return {};
  }
}

export function getKey(k: KeyName): string | undefined {
  const v = process.env[KEY_INFO[k].env] ?? readFile()[k];
  return v && v.trim() ? v.trim() : undefined;
}

/** Save / clear keys ("" or null removes one). Returns which keys are now set (never the values). */
export function setKeys(patch: Partial<Record<KeyName, string | null>>): Record<KeyName, boolean> {
  const cur = readFile();
  for (const k of KEY_NAMES) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v && v.trim()) cur[k] = v.trim().slice(0, 300);
    else delete cur[k];
  }
  writeFileSync(FILE, JSON.stringify(cur, null, 2));
  return keyStatus();
}

export function keyStatus(): Record<KeyName, boolean> {
  return Object.fromEntries(KEY_NAMES.map((k) => [k, !!getKey(k)])) as Record<KeyName, boolean>;
}

// ---------------------------------------------------------------- app settings (this PC only)

export type AppSettings = {
  /** Never let Claude Code bill an API key: hide API-key variables and stop if it still reports API-key auth. */
  subscriptionOnly: boolean;
};
const SETTINGS = path.join(APP_HOME, "settings.json");

export function getSettings(): AppSettings {
  let s: Partial<AppSettings> = {};
  try {
    if (existsSync(SETTINGS)) s = JSON.parse(readFileSync(SETTINGS, "utf8")) as Partial<AppSettings>;
  } catch {
    s = {};
  }
  return { subscriptionOnly: s.subscriptionOnly === true };
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...(typeof patch.subscriptionOnly === "boolean" ? { subscriptionOnly: patch.subscriptionOnly } : {}) };
  writeFileSync(SETTINGS, JSON.stringify(next, null, 2));
  return next;
}

/** The user's own opt-in (Home screen or VIDEO_EDITOR_SUBSCRIPTION_ONLY=1). Off by default. */
export const subscriptionOnly = () => process.env.VIDEO_EDITOR_SUBSCRIPTION_ONLY === "1" || getSettings().subscriptionOnly;
