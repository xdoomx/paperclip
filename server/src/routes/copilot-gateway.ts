import { Router, type Request, type Response } from "express";
import { readConfigFile } from "../config-file.js";

type LlmProvider = "openai" | "claude";

type GatewayLlmConfig = {
  provider: LlmProvider;
  apiKey: string;
};

const OPENAI_MODELS_FALLBACK: { id: string; label: string }[] = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini" },
  { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
];

const CLAUDE_MODELS_FALLBACK: { id: string; label: string }[] = [
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
];

function resolveLlmConfig(): GatewayLlmConfig | null {
  const openaiEnv = process.env.OPENAI_API_KEY?.trim();
  if (openaiEnv) return { provider: "openai", apiKey: openaiEnv };

  const anthropicEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicEnv) return { provider: "claude", apiKey: anthropicEnv };

  const fileConfig = readConfigFile();
  if (fileConfig?.llm) {
    const { provider, apiKey } = fileConfig.llm;
    const trimmedKey = apiKey?.trim();
    if (trimmedKey) {
      return { provider: provider as LlmProvider, apiKey: trimmedKey };
    }
  }

  return null;
}

function resolveGatewayAuthToken(): string | null {
  return process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN?.trim() || null;
}

function checkAuth(req: Request, res: Response, requiredToken: string): boolean {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token !== requiredToken) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

type ChatMessage = { role: string; content: string };

async function callOpenAiChat(input: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
}): Promise<{ summary: string; model: string; inputTokens: number; outputTokens: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({ model: input.model, messages: input.messages }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = (await response.json()) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const summary = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage ?? {};
    return {
      summary,
      model: data.model ?? input.model,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callClaudeChat(input: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
}): Promise<{ summary: string; model: string; inputTokens: number; outputTokens: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: input.model, messages: input.messages, max_tokens: 8192 }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = (await response.json()) as {
      model?: string;
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const summary = data.content?.find((b) => b.type === "text")?.text ?? "";
    const usage = data.usage ?? {};
    return {
      summary,
      model: data.model ?? input.model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function streamOpenAiChat(input: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  res: Response;
}): Promise<void> {
  const { apiKey, model, messages, timeoutMs, res } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let summary = "";
  let responseModel = model;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      res.write(`data: ${JSON.stringify({ type: "error", message: `OpenAI API error ${response.status}: ${text.slice(0, 200)}` })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (!response.body) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "OpenAI returned no body" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

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
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice("data:".length).trim();
          if (raw === "[DONE]") break;
          try {
            const chunk = JSON.parse(raw) as {
              model?: string;
              choices?: { delta?: { content?: string } }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            if (chunk.model) responseModel = chunk.model;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              summary += delta;
              res.write(`data: ${JSON.stringify({ type: "delta", text: delta })}\n\n`);
            }
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? 0;
              outputTokens = chunk.usage.completion_tokens ?? 0;
            }
          } catch {
            // ignore unparseable SSE lines
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }

  res.write(
    `data: ${JSON.stringify({
      type: "result",
      summary,
      provider: "openai",
      model: responseModel,
      usage: { inputTokens, outputTokens },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

async function streamClaudeChat(input: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  res: Response;
}): Promise<void> {
  const { apiKey, model, messages, timeoutMs, res } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let summary = "";
  let responseModel = model;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ model, messages, max_tokens: 8192, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      res.write(`data: ${JSON.stringify({ type: "error", message: `Anthropic API error ${response.status}: ${text.slice(0, 200)}` })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (!response.body) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Anthropic returned no body" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

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
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice("data:".length).trim();
          try {
            const event = JSON.parse(raw) as {
              type?: string;
              message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
              delta?: { type?: string; text?: string };
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (event.type === "message_start" && event.message) {
              if (event.message.model) responseModel = event.message.model;
              if (event.message.usage) {
                inputTokens = event.message.usage.input_tokens ?? 0;
              }
            } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              const text = event.delta.text ?? "";
              if (text) {
                summary += text;
                res.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
              }
            } else if (event.type === "message_delta" && event.usage) {
              outputTokens = event.usage.output_tokens ?? 0;
            }
          } catch {
            // ignore unparseable SSE lines
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }

  res.write(
    `data: ${JSON.stringify({
      type: "result",
      summary,
      provider: "claude",
      model: responseModel,
      usage: { inputTokens, outputTokens },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function normalizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const role = typeof rec.role === "string" ? rec.role.trim() : "";
    const content = typeof rec.content === "string" ? rec.content : "";
    if (role && content) out.push({ role, content });
  }
  return out;
}

export function copilotGatewayRoutes() {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/models", (req, res) => {
    const requiredToken = resolveGatewayAuthToken();
    if (requiredToken && !checkAuth(req, res, requiredToken)) return;

    const llm = resolveLlmConfig();
    if (!llm) {
      res.json([]);
      return;
    }
    const models = llm.provider === "claude" ? CLAUDE_MODELS_FALLBACK : OPENAI_MODELS_FALLBACK;
    res.json(models);
  });

  router.post("/chat", async (req, res) => {
    const requiredToken = resolveGatewayAuthToken();
    if (requiredToken && !checkAuth(req, res, requiredToken)) return;

    const llm = resolveLlmConfig();
    if (!llm) {
      res.status(503).json({ error: "No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY." });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const messages = normalizeMessages(body.messages);
    if (messages.length === 0) {
      res.status(400).json({ error: "messages array is required and must not be empty" });
      return;
    }

    const defaultModel = llm.provider === "claude" ? "claude-opus-4-5" : "gpt-4o";
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    const timeoutSec = typeof body.timeoutSec === "number" ? body.timeoutSec : 120;
    const timeoutMs = timeoutSec * 1000;

    try {
      let result: { summary: string; model: string; inputTokens: number; outputTokens: number };
      if (llm.provider === "claude") {
        result = await callClaudeChat({ apiKey: llm.apiKey, model, messages, timeoutMs });
      } else {
        result = await callOpenAiChat({ apiKey: llm.apiKey, model, messages, timeoutMs });
      }
      res.json({
        summary: result.summary,
        provider: llm.provider,
        model: result.model,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/chat/stream", async (req, res) => {
    const requiredToken = resolveGatewayAuthToken();
    if (requiredToken && !checkAuth(req, res, requiredToken)) return;

    const llm = resolveLlmConfig();
    if (!llm) {
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ type: "error", message: "No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY." })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const body = req.body as Record<string, unknown>;
    const messages = normalizeMessages(body.messages);
    if (messages.length === 0) {
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ type: "error", message: "messages array is required and must not be empty" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const defaultModel = llm.provider === "claude" ? "claude-opus-4-5" : "gpt-4o";
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    const timeoutSec = typeof body.timeoutSec === "number" ? body.timeoutSec : 120;
    const timeoutMs = timeoutSec * 1000;

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");

    try {
      if (llm.provider === "claude") {
        await streamClaudeChat({ apiKey: llm.apiKey, model, messages, timeoutMs, res });
      } else {
        await streamOpenAiChat({ apiKey: llm.apiKey, model, messages, timeoutMs, res });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.setHeader("content-type", "text/event-stream");
      }
      res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  return router;
}
