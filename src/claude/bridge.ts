// Runs the user's own, unmodified Claude Code in headless mode (signed in however they set it up — their Claude
// plan or their own API key) as a persistent, locked-down conversation per project, and streams its messages to
// the UI. The app never sees, stores or forwards Claude credentials.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import { emit } from "../server/bus";
import { APP_HOME, FREE_LIMITS, ROOT } from "../server/config";
import { subscriptionOnly } from "../server/keys";
import { baseUrl, type ChatMessage, getProject, newId, now, type Project, projectDir, saveProject } from "../server/store";
import { autonomousPrompt, scoutPrompt, systemPrompt } from "./prompt";

const AUTONOMOUS_TURNS = 25; // Night Shift may need many "continue" rounds; capped so a loop can't burn the plan
const hookCounts = new Map<string, number>(); // projectId -> hooks to propose (Night Shift setting)
const scoutCounts = new Map<string, number>(); // projectId -> clips to find (Night Shift "clips" scout job)

export const AGENT_TOKEN = crypto.randomUUID();

type Session = {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  projectId: string;
  busy: boolean;
  autopilotLeft: number;
  toolNames: Map<string, string>; // tool_use_id -> tool name
  resumed: boolean; // started with --resume
  autonomous: boolean; // Night Shift session (different prompt, never waits for the user)
  limit?: { resetsAt: number; type?: string }; // set when the Claude plan's usage limit was hit (unix seconds)
  initSeen: boolean; // the CLI got far enough to announce the session
  sent: string[]; // user messages written to this process (replayed if --resume fails)
  stopped?: boolean; // ended on purpose (stopClaude) — its exit code is not an error
};
const sessions = new Map<string, Session>();

/** Locate the real claude.exe (npm installs a .cmd shim, which can't be spawned directly). */
export function resolveClaude(): string | null {
  const env = process.env;
  const candidates = [
    env.VIDEO_EDITOR_CLAUDE_PATH,
    env.APPDATA && path.join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    env.USERPROFILE && path.join(env.USERPROFILE, ".local", "bin", "claude.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "claude", "claude.exe"),
    Bun.which("claude.exe") ?? undefined,
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

function addChat(p: Project, msg: Omit<ChatMessage, "id" | "at">): ChatMessage {
  const m: ChatMessage = { id: newId(), at: now(), ...msg };
  p.chat.push(m);
  if (p.chat.length > 400) p.chat.splice(0, p.chat.length - 400);
  saveProject(p, false);
  emit({ type: "chat", projectId: p.id, message: m });
  return m;
}

function setStatus(p: Project, status: Project["claude"]["status"], message?: string, options?: string[]) {
  p.claude.status = status;
  p.claude.message = message;
  p.claude.options = options;
  saveProject(p, false);
  emit({ type: "claude", projectId: p.id, state: status, detail: { message, options } });
}

/** Called by the set_status tool (through the API). */
export function reportStatus(projectId: string, state: "working" | "needs_user" | "done", message: string, options?: string[]) {
  const p = getProject(projectId);
  if (p) setStatus(p, state, message, options);
}

const short = (v: unknown, n = 140) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "get_project": return "Reading the project";
    case "get_transcript": return `Reading the transcript (${input.timeline ?? "output"} time)`;
    case "get_silences": return "Checking pauses";
    case "view_source_frames": return "Looking at your footage";
    case "preview_edit": return "Rendering a preview to check the edit";
    case "auto_cut": return "Cutting silences and filler words";
    case "set_clips": return `Arranging ${(input.clips as unknown[] | undefined)?.length ?? 0} clips`;
    case "upsert_layers": {
      const n = ["overlays", "effects", "music", "sfx"].map((k) => (input[k] as unknown[] | undefined)?.length ?? 0).reduce((a, b) => a + b, 0);
      return `Adding/updating ${n} layer${n === 1 ? "" : "s"}${input.reason ? ` — ${input.reason}` : ""}`;
    }
    case "remove_layers": return `Removing ${(input.ids as unknown[] | undefined)?.length ?? 0} layer(s)`;
    case "update_settings": return `Changing ${Object.keys((input.patch as object) ?? {}).join(", ")}`;
    case "set_spec": return "Rebuilding the whole edit";
    case "undo": return "Undoing the last change";
    case "set_status": return `Status: ${input.state}`;
    default: return name;
  }
}

function writeMcpConfig(p: Project): string {
  // Lives outside the project folder: it carries the per-run tool token and must never be served by /files.
  const dir = path.join(APP_HOME, "cache", "mcp");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${p.id}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        editor: {
          command: process.execPath, // this same Bun binary
          args: [path.join(ROOT, "src", "claude", "mcp.ts")],
          env: { VIDEO_EDITOR_PROJECT: p.id, VIDEO_EDITOR_API: baseUrl(), VIDEO_EDITOR_TOKEN: AGENT_TOKEN },
        },
      },
    }),
  );
  return file;
}

function start(p: Project): Session {
  const exe = resolveClaude();
  if (!exe) throw new Error("Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) and log in once with `claude`.");
  const args = [
    exe, "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    // Ignore every settings file (the user's hooks/plugins never run here) and confine the session.
    // NOT --safe-mode: verified that it also drops --mcp-config servers, leaving Claude with no tools.
    "--restricted",
    "--tools", "", // no built-in tools: no shell, no file access, no web
    "--strict-mcp-config", "--mcp-config", writeMcpConfig(p),
    "--allowedTools", "mcp__editor",
    "--permission-prompts", "none",
    "--system-prompt",
    systemPrompt("the creator") + (p.claude.mode !== "autonomous" ? "" : scoutCounts.has(p.id) ? scoutPrompt(scoutCounts.get(p.id)!) : autonomousPrompt(hookCounts.get(p.id) ?? 4)),
    "--name", `Video Editor: ${p.name}`.slice(0, 60),
  ];
  if (p.claude.model) args.push("--model", p.claude.model);
  if (p.claude.sessionId) args.push("--resume", p.claude.sessionId);

  // Claude Code runs exactly as the user set it up (their own subscription login or their own API key).
  // Optional "subscription only" setting (the user's own choice): hide API-key variables so usage stays on the plan.
  const env: Record<string, string | undefined> = { ...process.env };
  if (subscriptionOnly()) {
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete env[k];
  }
  // Some editor tools legitimately take minutes on a laptop (a voiceover, a preview render): don't time them out.
  env.MCP_TOOL_TIMEOUT = "1200000";

  const proc = Bun.spawn(args, { cwd: projectDir(p.id), stdin: "pipe", stdout: "pipe", stderr: "pipe", env, windowsHide: true });
  const s: Session = {
    proc, projectId: p.id, busy: false, toolNames: new Map(),
    autonomous: p.claude.mode === "autonomous",
    autopilotLeft: p.claude.mode === "autonomous" ? AUTONOMOUS_TURNS : FREE_LIMITS.autopilotMaxTurns,
    resumed: !!p.claude.sessionId, initSeen: false, sent: [],
  };
  sessions.set(p.id, s);
  void pumpOutput(s);
  void (async () => {
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (sessions.get(p.id) === s) sessions.delete(p.id);
    if (s.stopped) return; // killed on purpose: nothing went wrong
    const fresh = getProject(p.id);
    // The saved conversation couldn't be reopened (deleted, or the project moved): start a fresh one
    // and replay what the user just sent, instead of failing.
    if (fresh && code !== 0 && s.resumed && (!s.initSeen || /no conversation|not found/i.test(err))) {
      fresh.claude.sessionId = undefined;
      saveProject(fresh, false);
      addChat(fresh, { role: "system", text: "Couldn't reopen the previous Claude conversation — started a fresh one." });
      const retry = start(fresh);
      for (const t of s.sent) writeUser(retry, t);
      return;
    }
    if (fresh && code !== 0 && fresh.claude.status !== "idle") {
      addChat(fresh, { role: "system", text: `Claude stopped (exit ${code}). ${short(err.trim(), 400)}` });
      setStatus(fresh, "error", "Claude stopped unexpectedly — send a message to restart.");
    }
  })();
  return s;
}

function writeUser(s: Session, text: string) {
  s.busy = true;
  s.sent.push(text);
  s.proc.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`);
  s.proc.stdin.flush();
}

type StreamMsg = {
  type: string;
  subtype?: string;
  session_id?: string;
  apiKeySource?: string;
  mcp_servers?: { name: string; status: string }[];
  message?: { content?: ({ type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown })[] };
  is_error?: boolean;
  result?: string;
  rate_limit_info?: {
    status?: string; resetsAt?: number; rateLimitType?: string;
    unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
  };
};

async function pumpOutput(s: Session) {
  const dec = new TextDecoder();
  let pending = "";
  for await (const chunk of s.proc.stdout) {
    pending += dec.decode(chunk, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: StreamMsg;
      try {
        msg = JSON.parse(line) as StreamMsg;
      } catch {
        continue;
      }
      handle(s, msg);
    }
  }
}

function handle(s: Session, msg: StreamMsg) {
  const p = getProject(s.projectId);
  if (!p) return;
  if (msg.type === "system" && msg.subtype === "init") {
    s.initSeen = true;
    if (msg.apiKeySource && msg.apiKeySource !== "none") {
      if (subscriptionOnly()) {
        // The user asked for plan-only usage: don't run on per-token billing.
        addChat(p, { role: "system", text: `Stopped: Claude Code is using an API key (${msg.apiKeySource}) and "subscription only" is on. Sign in with your Claude plan (run \`claude\`, then /login) or turn the setting off on the Home screen.` });
        setStatus(p, "error", "API-key billing detected — stopped (subscription only is on).");
        s.proc.kill();
        return;
      }
      if (!s.resumed) addChat(p, { role: "system", text: `Note: Claude Code is using an API key (${msg.apiKeySource}) — Anthropic bills that key per use.` });
    }
    const mcp = msg.mcp_servers?.find((m) => m.name === "editor");
    if (!mcp || mcp.status !== "connected") {
      addChat(p, { role: "system", text: `Editor tools failed to connect (${mcp?.status ?? "missing"}).` });
    }
    if (msg.session_id && p.claude.sessionId !== msg.session_id) {
      p.claude.sessionId = msg.session_id;
      saveProject(p, false);
    }
    return;
  }
  if (msg.type === "rate_limit_event" && msg.rate_limit_info) {
    const info = msg.rate_limit_info;
    emit({ type: "claude", projectId: p.id, state: "usage", detail: info });
    if (info.status === "rejected") {
      const windows = Object.values(info.unifiedWindows ?? {}).map((w) => w.resetsAt ?? 0);
      s.limit = { resetsAt: info.resetsAt ?? Math.max(0, ...windows), type: info.rateLimitType };
    }
    return;
  }
  if (msg.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) addChat(p, { role: "assistant", text: block.text.trim() });
      if (block.type === "tool_use" && block.name) {
        const name = block.name.replace(/^mcp__editor__/, "");
        if (block.id) s.toolNames.set(block.id, name);
        if (name !== "set_status") addChat(p, { role: "tool", text: toolSummary(name, block.input ?? {}), tool: { name, ok: true } });
      }
    }
    return;
  }
  if (msg.type === "user") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "tool_result" && block.is_error) {
        const name = (block.tool_use_id && s.toolNames.get(block.tool_use_id)) || "tool";
        const detail = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? "").join(" ") : String(block.content ?? "");
        addChat(p, { role: "tool", text: `${name} needed a fix: ${short(detail, 220)}`, tool: { name, ok: false } });
      }
    }
    return;
  }
  if (msg.type === "result") {
    s.busy = false;
    if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
      const text = String(msg.result ?? msg.subtype ?? "");
      if (/usage limit|rate limit|limit reached|too many requests|overloaded/i.test(text)) {
        const epoch = Number(/\|(\d{9,})/.exec(text)?.[1]);
        s.limit ??= { resetsAt: Number.isFinite(epoch) ? epoch : Math.floor(Date.now() / 1000) + 1800 };
        addChat(p, { role: "system", text: "Claude's usage limit was reached — it will continue after the limit resets." });
        setStatus(p, "error", "Claude usage limit reached.");
        return;
      }
      addChat(p, { role: "system", text: `Claude hit a problem: ${short(text, 300)}` });
      setStatus(p, "error", "Something went wrong — try again or rephrase.");
      return;
    }
    const fresh = getProject(p.id)!;
    if (s.autonomous && fresh.claude.status === "needs_user" && s.autopilotLeft > 0) {
      // Night Shift: nobody is awake to answer — make Claude decide.
      s.autopilotLeft--;
      setStatus(fresh, "working", "Deciding on its own (Night Shift)…");
      writeUser(s, "The creator is asleep and can't answer. Make the best decision yourself and finish the job.");
      return;
    }
    if (fresh.claude.status === "working") {
      if (s.autopilotLeft > 0) {
        s.autopilotLeft--;
        writeUser(s, "Continue with the next step of your plan.");
      } else {
        setStatus(fresh, "needs_user", "Paused to protect your Claude usage. Say “continue” to keep going.", ["Continue"]);
      }
    } else if (fresh.claude.status === "starting") {
      // Claude ended its turn without calling set_status.
      setStatus(fresh, "done", "Ready for your next request.");
    }
  }
}

export function sendToClaude(projectId: string, text: string, model?: string) {
  const p = getProject(projectId);
  if (!p) throw new Error("project not found");
  if (model !== undefined && model !== (p.claude.model ?? "")) {
    p.claude.model = model || undefined;
    stopClaude(projectId); // model is fixed per process
  }
  let s = sessions.get(projectId);
  const autonomous = p.claude.mode === "autonomous";
  if (s && s.autonomous !== autonomous) {
    stopClaude(projectId); // the system prompt differs per mode
    s = undefined;
  }
  if (!s || s.proc.exitCode !== null || s.proc.killed) s = start(p);
  s.autopilotLeft = autonomous ? AUTONOMOUS_TURNS : FREE_LIMITS.autopilotMaxTurns;
  s.limit = undefined;
  addChat(p, { role: "user", text });
  setStatus(p, "starting", "Claude is thinking…");
  writeUser(s, text);
}

export function stopClaude(projectId: string) {
  const s = sessions.get(projectId);
  if (!s) return;
  sessions.delete(projectId);
  s.stopped = true;
  try {
    s.proc.kill();
  } catch {
    /* already gone */
  }
  const p = getProject(projectId);
  if (p && p.claude.status !== "idle") setStatus(p, "idle", "Stopped.");
}

export function isClaudeBusy(projectId: string) {
  return sessions.get(projectId)?.busy ?? false;
}

export function stopAll() {
  for (const id of [...sessions.keys()]) stopClaude(id);
}

export type AutoOutcome =
  | { outcome: "done"; message?: string }
  | { outcome: "limit"; resetsAt: number } // unix seconds when the Claude plan's window resets
  | { outcome: "error" | "timeout"; message: string };

/**
 * Night Shift: run Claude on a project in autonomous mode until it reports done (or hits the usage limit,
 * an error, or the time budget). Always returns the project to normal (interactive) chat mode afterwards.
 */
export async function runAutonomous(
  projectId: string,
  text: string,
  opts: { model?: string; hooks: number; timeoutMs: number; signal?: AbortSignal; job?: "edit" | "scout"; clips?: number },
): Promise<AutoOutcome> {
  const p = getProject(projectId);
  if (!p) return { outcome: "error", message: "project not found" };
  hookCounts.set(projectId, opts.hooks);
  if (opts.job === "scout") scoutCounts.set(projectId, opts.clips ?? 10);
  else scoutCounts.delete(projectId);
  p.claude.mode = "autonomous";
  saveProject(p, false);
  let result: AutoOutcome;
  try {
    sendToClaude(projectId, text, opts.model);
    result = await watchAutonomous(projectId, opts);
  } catch (e) {
    result = { outcome: "error", message: (e as Error).message };
  } finally {
    stopClaude(projectId); // the session is resumable later from the editor's chat
    hookCounts.delete(projectId);
    scoutCounts.delete(projectId);
  }
  const fresh = getProject(projectId);
  if (fresh) {
    fresh.claude.mode = undefined;
    // Keep Claude's own summary on screen (stopClaude would leave "Stopped.").
    if (result.outcome === "done") setStatus(fresh, "done", result.message);
    else saveProject(fresh, false);
  }
  return result;
}

async function watchAutonomous(projectId: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<AutoOutcome> {
  const started = Date.now();
  let deadSince = 0;
  let last: Session | undefined;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = sessions.get(projectId);
    if (s) last = s;
    const fresh = getProject(projectId);
    if (!fresh) return { outcome: "error", message: "project disappeared" };
    if (opts.signal?.aborted) return { outcome: "error", message: "cancelled" };
    if (last?.limit) return { outcome: "limit", resetsAt: last.limit.resetsAt };
    const status = fresh.claude.status;
    const busy = s?.busy ?? false;
    if (!busy && (status === "done" || status === "needs_user")) return { outcome: "done", message: fresh.claude.message };
    if (!busy && status === "error") return { outcome: "error", message: fresh.claude.message ?? "Claude stopped" };
    if (!s) {
      deadSince ||= Date.now();
      if (Date.now() - deadSince > 15000) return { outcome: "error", message: fresh.claude.message ?? "Claude exited" };
    } else deadSince = 0;
    if (Date.now() - started > opts.timeoutMs) return { outcome: "timeout", message: `no finish after ${Math.round(opts.timeoutMs / 60000)} min` };
  }
}
