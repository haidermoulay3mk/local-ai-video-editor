// Text-message conversation parsing, shared by the chat template (render) and the editor (validation / sfx timing).

export type ChatMsg = { me: boolean; who: string; text: string };

/** "me: hey | Sam: what? | me: ..." (or one message per line). Lines from "me"/"I" go on the right. */
export function parseChat(raw: string): ChatMsg[] {
  return raw
    .split(/\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^([^:]{1,24}):\s*(.*)$/.exec(line);
      if (!m) return { me: false, who: "", text: line };
      const who = m[1]!.trim();
      const me = /^(me|i)$/i.test(who);
      return { me, who: me || /^them$/i.test(who) ? "" : who, text: m[2]!.trim() };
    })
    .filter((m) => m.text);
}

/** When each message lands (seconds from the layer start). Spread evenly unless `perMessage` is given. */
export function chatTimes(msgs: ChatMsg[], durSec: number, perMessage?: number): number[] {
  const per = perMessage ?? Math.max(0.6, (durSec - 0.8) / Math.max(1, msgs.length));
  return msgs.map((_, i) => 0.35 + i * per);
}
