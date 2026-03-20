import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseAssistantEntries(messageRaw: unknown, ts: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    if (text) entries.push({ kind: "assistant", ts, text });
    return entries;
  }

  const message = asRecord(messageRaw);
  if (!message) return entries;

  const directText = asString(message.text).trim();
  if (directText) entries.push({ kind: "assistant", ts, text: directText });

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type).trim();

    if (type === "output_text" || type === "text") {
      const text = asString(part.text).trim();
      if (text) entries.push({ kind: "assistant", ts, text });
      continue;
    }

    if (type === "thinking") {
      const text = asString(part.text).trim();
      if (text) entries.push({ kind: "thinking", ts, text });
      continue;
    }

    if (type === "tool_call") {
      const name = asString(part.name, asString(part.tool, "tool"));
      const input = part.input ?? part.arguments ?? part.args ?? {};
      entries.push({
        kind: "tool_call",
        ts,
        name,
        toolUseId: asString(part.id, asString(part.tool_use_id, name)),
        input,
      });
      continue;
    }

    if (type === "tool_result") {
      const isError =
        part.is_error === true || asString(part.status).toLowerCase() === "error";
      const content =
        asString(part.output) || asString(part.text) || asString(part.result) || stringifyUnknown(part);
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId: asString(part.tool_use_id, asString(part.id, "")),
        content,
        isError,
      });
      continue;
    }
  }

  return entries;
}

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = safeJsonParse(line.trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return line.trim() ? [{ kind: "stdout", ts, text: line }] : [];
  }

  const event = parsed as Record<string, unknown>;
  const type = asString(event.type).trim();

  if (type === "system" || type === "init") {
    const sessionId =
      asString(event.session_id) ||
      asString(event.sessionId) ||
      asString(event.sessionID);
    const model = asString(event.model);
    const parts: string[] = [];
    if (sessionId) parts.push(`session: ${sessionId}`);
    if (model) parts.push(`model: ${model}`);
    return [
      {
        kind: "init",
        ts,
        model: model || undefined,
        sessionId: sessionId || undefined,
      } as TranscriptEntry,
    ];
  }

  if (type === "assistant" || type === "message") {
    return parseAssistantEntries(event.message ?? event.content ?? event.text, ts);
  }

  if (type === "user") {
    const text = asString(event.message ?? event.text).trim();
    return text ? [{ kind: "user", ts, text }] : [];
  }

  if (type === "thinking") {
    const text = asString(event.text).trim() || asString(asRecord(event.delta)?.text).trim();
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "tool_call") {
    const toolCall = asRecord(event.tool_call ?? event.toolCall);
    if (toolCall) {
      const [toolName] = Object.keys(toolCall);
      if (toolName) {
        const payload = asRecord(toolCall[toolName]) ?? {};
        const args = payload.args ?? asRecord(payload.function)?.arguments ?? payload;
        return [
          {
            kind: "tool_call",
            ts,
            name: toolName,
            toolUseId: asString(event.call_id, asString(event.callId, toolName)),
            input: args,
          },
        ];
      }
    }
    const name = asString(event.name, "tool");
    return [
      {
        kind: "tool_call",
        ts,
        name,
        toolUseId: asString(event.id, name),
        input: event.input ?? event.arguments ?? {},
      },
    ];
  }

  if (type === "result" || type === "done") {
    const usage = asRecord(event.usage);
    const inputTokens = usage
      ? asNumber(usage.input_tokens, asNumber(usage.inputTokens, 0))
      : 0;
    const outputTokens = usage
      ? asNumber(usage.output_tokens, asNumber(usage.outputTokens, 0))
      : 0;
    const cachedTokens = usage
      ? asNumber(
          usage.cached_input_tokens,
          asNumber(
            usage.cachedInputTokens,
            asNumber(usage.cache_read_input_tokens, 0),
          ),
        )
      : 0;
    const costUsd = asNumber(
      event.total_cost_usd,
      asNumber(event.cost_usd, asNumber(event.cost, 0)),
    );
    const subtype = asString(event.subtype, "result");
    const isError = event.is_error === true || subtype === "error" || subtype === "failed";
    const resultText = asString(event.result).trim();
    const errors = Array.isArray(event.errors)
      ? event.errors.map((v) => stringifyUnknown(v)).filter(Boolean)
      : [];
    return [
      {
        kind: "result",
        ts,
        text: resultText,
        inputTokens,
        outputTokens,
        cachedTokens,
        costUsd,
        subtype,
        isError,
        errors,
      },
    ];
  }

  if (type === "error") {
    const message =
      asString(event.message) || stringifyUnknown(event.error ?? event.detail) || line;
    return [
      {
        kind: "result" as const,
        ts,
        text: message,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "error",
        isError: true,
        errors: [message],
      },
    ];
  }

  return line.trim() ? [{ kind: "stdout", ts, text: line }] : [];
}
