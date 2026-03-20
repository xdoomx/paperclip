import pc from "picocolors";

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

function printAssistantMessage(messageRaw: unknown): void {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  const message = asRecord(messageRaw);
  if (!message) return;

  const directText = asString(message.text).trim();
  if (directText) console.log(pc.green(`assistant: ${directText}`));

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type).trim();

    if (type === "output_text" || type === "text") {
      const text = asString(part.text).trim();
      if (text) console.log(pc.green(`assistant: ${text}`));
      continue;
    }

    if (type === "thinking") {
      const text = asString(part.text).trim();
      if (text) console.log(pc.gray(`thinking: ${text}`));
      continue;
    }

    if (type === "tool_call") {
      const name = asString(part.name, asString(part.tool, "tool"));
      console.log(pc.yellow(`tool_call: ${name}`));
      const input = part.input ?? part.arguments ?? part.args;
      if (input !== undefined) {
        try {
          console.log(pc.gray(JSON.stringify(input, null, 2)));
        } catch {
          console.log(pc.gray(String(input)));
        }
      }
      continue;
    }

    if (type === "tool_result") {
      const isError = part.is_error === true || asString(part.status).toLowerCase() === "error";
      const contentText =
        asString(part.output) ||
        asString(part.text) ||
        asString(part.result) ||
        stringifyUnknown(part.output ?? part.result ?? part.text ?? part);
      console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
      if (contentText) console.log((isError ? pc.red : pc.gray)(contentText));
    }
  }
}

export function printCopilotStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);

  if (type === "system" || type === "init") {
    const sessionId =
      asString(parsed.session_id) ||
      asString(parsed.sessionId) ||
      asString(parsed.sessionID);
    const model = asString(parsed.model);
    const details = [sessionId ? `session: ${sessionId}` : "", model ? `model: ${model}` : ""]
      .filter(Boolean)
      .join(", ");
    console.log(pc.blue(`Copilot init${details ? ` (${details})` : ""}`));
    return;
  }

  if (type === "assistant" || type === "message") {
    printAssistantMessage(parsed.message ?? parsed.content ?? parsed.text);
    return;
  }

  if (type === "user") {
    const text = asString(parsed.message ?? parsed.text).trim();
    if (text) console.log(pc.gray(`user: ${text}`));
    return;
  }

  if (type === "thinking") {
    const text = asString(parsed.text).trim() || asString(asRecord(parsed.delta)?.text).trim();
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }

  if (type === "tool_call") {
    const toolCall = asRecord(parsed.tool_call ?? parsed.toolCall);
    if (toolCall) {
      const [toolName] = Object.keys(toolCall);
      if (toolName) {
        const payload = asRecord(toolCall[toolName]) ?? {};
        const args = payload.args ?? asRecord(payload.function)?.arguments;
        console.log(pc.yellow(`tool_call: ${toolName}`));
        if (args !== undefined) console.log(pc.gray(stringifyUnknown(args)));
        return;
      }
    }
    const name = asString(parsed.name, "tool");
    console.log(pc.yellow(`tool_call: ${name}`));
    if (parsed.input !== undefined) console.log(pc.gray(stringifyUnknown(parsed.input)));
    return;
  }

  if (type === "result" || type === "done") {
    const usage = asRecord(parsed.usage);
    const input = usage
      ? asNumber(usage.input_tokens, asNumber(usage.inputTokens))
      : 0;
    const output = usage
      ? asNumber(usage.output_tokens, asNumber(usage.outputTokens))
      : 0;
    const cached = usage
      ? asNumber(
          usage.cached_input_tokens,
          asNumber(usage.cachedInputTokens, asNumber(usage.cache_read_input_tokens)),
        )
      : 0;
    const cost = asNumber(
      parsed.total_cost_usd,
      asNumber(parsed.cost_usd, asNumber(parsed.cost)),
    );
    const subtype = asString(parsed.subtype, "result");
    const isError = parsed.is_error === true || subtype === "error" || subtype === "failed";

    console.log(pc.blue(`result: subtype=${subtype}`));
    console.log(
      pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`),
    );
    const resultText = asString(parsed.result).trim();
    if (resultText) console.log((isError ? pc.red : pc.green)(`assistant: ${resultText}`));
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.map((v) => stringifyUnknown(v)).filter(Boolean)
      : [];
    if (errors.length > 0) console.log(pc.red(`errors: ${errors.join(" | ")}`));
    return;
  }

  if (type === "error") {
    const message =
      asString(parsed.message) || stringifyUnknown(parsed.error ?? parsed.detail) || line;
    console.log(pc.red(`error: ${message}`));
    return;
  }

  console.log(line);
}
