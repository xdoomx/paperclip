import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

export function parseCopilotJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let totalCostUsd = 0;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "").trim();

    const foundSession =
      asString(event.session_id, "").trim() ||
      asString(event.sessionId, "").trim() ||
      asString(event.sessionID, "").trim() ||
      asString(event.thread_id, "").trim() ||
      asString(event.conversationId, "").trim() ||
      null;
    if (foundSession) sessionId = foundSession;

    if (type === "system" || type === "init") {
      continue;
    }

    if (type === "assistant" || type === "message") {
      const messageRaw = event.message ?? event.content ?? event.text;
      if (typeof messageRaw === "string") {
        const text = messageRaw.trim();
        if (text) messages.push(text);
      } else {
        const messageRec = parseObject(messageRaw);
        const directText = asString(messageRec.text, "").trim();
        if (directText) {
          messages.push(directText);
        } else {
          const content = Array.isArray(messageRec.content) ? messageRec.content : [];
          for (const partRaw of content) {
            const part = parseObject(partRaw);
            const partType = asString(part.type, "").trim();
            if (partType === "output_text" || partType === "text") {
              const text = asString(part.text, "").trim();
              if (text) messages.push(text);
            }
          }
        }
      }
      continue;
    }

    if (type === "result" || type === "turn.completed" || type === "done") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens += asNumber(
        usageObj.input_tokens,
        asNumber(usageObj.inputTokens, 0),
      );
      usage.cachedInputTokens += asNumber(
        usageObj.cached_input_tokens,
        asNumber(usageObj.cachedInputTokens, asNumber(usageObj.cache_read_input_tokens, 0)),
      );
      usage.outputTokens += asNumber(
        usageObj.output_tokens,
        asNumber(usageObj.outputTokens, 0),
      );
      totalCostUsd += asNumber(
        event.total_cost_usd,
        asNumber(event.cost_usd, asNumber(event.cost, 0)),
      );

      const isError =
        event.is_error === true ||
        asString(event.subtype, "").toLowerCase() === "error" ||
        asString(event.subtype, "").toLowerCase() === "failed";
      const resultText = asString(event.result, "").trim();
      if (resultText && messages.length === 0) {
        messages.push(resultText);
      }
      if (isError && !errorMessage) {
        const errText =
          asString(event.error, "").trim() ||
          asString(event.message, "").trim() ||
          (resultText && isError ? resultText : "");
        if (errText) errorMessage = errText;
      }
      continue;
    }

    if (type === "error") {
      const msg =
        asString(event.message, "").trim() ||
        asString(event.error, "").trim() ||
        asString(parseObject(event.error).message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "turn.failed") {
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
    errorMessage,
  };
}

export function isCopilotUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown\s+(session|thread|conversation)|(?:session|thread|conversation)\s+(?:.*\s+)?not\s+found|could\s+not\s+resume/i.test(
    haystack,
  );
}
