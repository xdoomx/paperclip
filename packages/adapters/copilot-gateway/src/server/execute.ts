import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function normalizeUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function buildAuthHeaders(authToken: string | null): Record<string, string> {
  if (!authToken) return {};
  return { authorization: `Bearer ${authToken}` };
}

type ParsedSseEvent = {
  type: "delta" | "result" | "error" | "done" | "unknown";
  text?: string;
  summary?: string;
  provider?: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number;
  message?: string;
  raw?: string;
};

function parseSseLine(line: string): ParsedSseEvent | null {
  if (!line.startsWith("data:")) return null;
  const raw = line.slice("data:".length).trim();
  if (raw === "[DONE]") return { type: "done" };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { type: "unknown", raw };
    const rec = parsed as Record<string, unknown>;
    const eventType = typeof rec.type === "string" ? rec.type : "unknown";
    if (eventType === "delta") {
      return {
        type: "delta",
        text: typeof rec.text === "string" ? rec.text : "",
      };
    }
    if (eventType === "result") {
      return {
        type: "result",
        summary: typeof rec.summary === "string" ? rec.summary : undefined,
        provider: typeof rec.provider === "string" ? rec.provider : undefined,
        model: typeof rec.model === "string" ? rec.model : undefined,
        usage:
          rec.usage && typeof rec.usage === "object"
            ? (rec.usage as { inputTokens?: number; outputTokens?: number })
            : undefined,
        costUsd: typeof rec.costUsd === "number" ? rec.costUsd : undefined,
      };
    }
    if (eventType === "error") {
      return {
        type: "error",
        message: typeof rec.message === "string" ? rec.message : "Gateway error",
      };
    }
    return { type: "unknown", raw };
  } catch {
    return { type: "unknown", raw };
  }
}

async function executeStreaming(input: {
  baseUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<AdapterExecutionResult> {
  const { baseUrl, headers, body, timeoutMs, onLog } = input;
  const url = `${baseUrl}/chat/stream`;

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Copilot gateway returned HTTP ${response.status}: ${text.trim()}`,
        errorCode: "copilot_gateway_http_error",
      };
    }

    if (!response.body) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Copilot gateway returned no response body",
        errorCode: "copilot_gateway_no_body",
      };
    }

    let summary: string | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let costUsd: number | undefined;
    let hadError = false;
    let errorMessage = "";

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = parseSseLine(trimmed);
          if (!event) continue;
          if (event.type === "delta" && event.text) {
            await onLog("stdout", `[copilot-gateway:event] stream=assistant data=${JSON.stringify({ delta: event.text })}\n`);
          } else if (event.type === "result") {
            summary = event.summary;
            provider = event.provider;
            model = event.model;
            if (event.usage) {
              usage = {
                inputTokens: event.usage.inputTokens ?? 0,
                outputTokens: event.usage.outputTokens ?? 0,
              };
            }
            costUsd = event.costUsd;
          } else if (event.type === "error") {
            hadError = true;
            errorMessage = event.message ?? "Gateway stream error";
            await onLog("stderr", `[copilot-gateway] stream error: ${errorMessage}\n`);
          } else if (event.type === "done") {
            break;
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    if (hadError) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage,
        errorCode: "copilot_gateway_stream_error",
      };
    }

    await onLog("stdout", `[copilot-gateway] run completed status=ok\n`);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(costUsd != null && costUsd > 0 ? { costUsd } : {}),
      ...(summary ? { summary } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout");
    await onLog("stderr", `[copilot-gateway] request failed: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut,
      errorMessage: message,
      errorCode: timedOut ? "copilot_gateway_timeout" : "copilot_gateway_request_failed",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executeNonStreaming(input: {
  baseUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<AdapterExecutionResult> {
  const { baseUrl, headers, body, timeoutMs, onLog } = input;
  const url = `${baseUrl}/chat`;

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Copilot gateway returned HTTP ${response.status}: ${text.trim()}`,
        errorCode: "copilot_gateway_http_error",
      };
    }

    const json = await response.json().catch(() => null);
    const result = asRecord(json);

    const summary = nonEmpty(result?.summary);
    const provider = nonEmpty(result?.provider);
    const model = nonEmpty(result?.model);
    const costUsd = typeof result?.costUsd === "number" ? result.costUsd : 0;
    const usageRaw = asRecord(result?.usage);
    const usage =
      usageRaw
        ? {
            inputTokens: typeof usageRaw.inputTokens === "number" ? usageRaw.inputTokens : 0,
            outputTokens: typeof usageRaw.outputTokens === "number" ? usageRaw.outputTokens : 0,
          }
        : undefined;

    await onLog("stdout", `[copilot-gateway] run completed status=ok\n`);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(costUsd > 0 ? { costUsd } : {}),
      ...(summary ? { summary } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout");
    await onLog("stderr", `[copilot-gateway] request failed: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut,
      errorMessage: message,
      errorCode: timedOut ? "copilot_gateway_timeout" : "copilot_gateway_request_failed",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const urlValue = asString(ctx.config.url, "").trim();
  if (!urlValue) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Copilot gateway adapter missing url",
      errorCode: "copilot_gateway_url_missing",
    };
  }

  const baseUrl = normalizeUrl(urlValue);
  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Invalid or unsupported gateway URL: ${urlValue}. Use http:// or https://.`,
      errorCode: "copilot_gateway_url_invalid",
    };
  }

  const authToken = nonEmpty(ctx.config.authToken) ?? nonEmpty(ctx.config.token);
  const model = nonEmpty(ctx.config.model);
  const timeoutSec = asNumber(ctx.config.timeoutSec, 120);
  const timeoutMs = timeoutSec * 1000;
  const useStream = parseBoolean(ctx.config.stream, false);
  const extraHeaders = toStringRecord(ctx.config.headers);

  const headers: Record<string, string> = {
    ...buildAuthHeaders(authToken),
    ...extraHeaders,
  };

  const context = ctx.context;
  const taskId = nonEmpty(context.taskId) ?? null;
  const issueId = nonEmpty(context.issueId) ?? null;
  const wakeReason = nonEmpty(context.wakeReason) ?? null;
  const wakeText = nonEmpty(context.wakeText) ?? null;

  const body: Record<string, unknown> = {
    runId: ctx.runId,
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    taskId,
    issueId,
    wakeReason,
    ...(model ? { model } : {}),
    messages: [
      {
        role: "user",
        content: wakeText ?? `Run ${ctx.runId}`,
      },
    ],
    context,
  };

  await ctx.onLog("stdout", `[copilot-gateway] invoking ${useStream ? "stream" : "chat"} endpoint at ${baseUrl}\n`);

  if (useStream) {
    return executeStreaming({ baseUrl, headers, body, timeoutMs, onLog: ctx.onLog });
  }
  return executeNonStreaming({ baseUrl, headers, body, timeoutMs, onLog: ctx.onLog });
}
