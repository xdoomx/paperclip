import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseCopilotGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[copilot-gateway:event]")) {
    const match = trimmed.match(/^\[copilot-gateway:event\]\s+stream=([^\s]+)\s+data=(.*)$/s);
    if (match) {
      const stream = (match[1] ?? "").toLowerCase();
      const dataStr = (match[2] ?? "").trim();
      if (stream === "assistant") {
        try {
          const data = JSON.parse(dataStr) as Record<string, unknown>;
          const delta = typeof data.delta === "string" ? data.delta : "";
          if (delta.length > 0) {
            return [{ kind: "assistant", ts, text: delta, delta: true }];
          }
        } catch {
          // ignore parse errors
        }
      }
    }
    return [];
  }

  if (trimmed.startsWith("[copilot-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[copilot-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
