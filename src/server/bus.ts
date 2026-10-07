// Tiny pub/sub used to push live updates (ingest progress, spec changes, Claude messages) to the UI.
export type BusEvent =
  | { type: "project"; projectId: string } // project.json changed — clients refetch
  | { type: "spec"; projectId: string; reason: string }
  | { type: "progress"; projectId: string; task: string; mediaId?: string; progress: number; message?: string }
  | { type: "chat"; projectId: string; message: unknown }
  | { type: "claude"; projectId: string; state: string; detail?: unknown }
  | { type: "render"; projectId: string; state: "queued" | "running" | "done" | "error" | "cancelled"; progress?: number; file?: string; error?: string }
  | { type: "night"; projectId: typeof NIGHT_CHANNEL; batchId: string }; // Night Shift progress (global channel)

export const NIGHT_CHANNEL = "__night" as const;

type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();

export function emit(e: BusEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch (err) {
      console.error("bus listener failed", err);
    }
  }
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
