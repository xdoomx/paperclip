import { Router, type Request, type Response } from "express";

const COPILOT_CHAT_API_BASE = "https://api.individual.githubcopilot.com";
const COPILOT_TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_EDITOR_VERSION = "paperclip/1.0";
const COPILOT_EDITOR_PLUGIN_VERSION = "paperclip-copilot-gateway/1.0";
const TOKEN_EXCHANGE_TIMEOUT_MS = 5_000;
const TOKEN_CACHE_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_COPILOT_TOKEN_TTL_MS = 25 * 60 * 1000;
const ERROR_MESSAGE_MAX_LENGTH = 200;
const DEFAULT_COPILOT_MODEL = "gpt-4o";
const DEFAULT_TIMEOUT_SEC = 120;

// Models supported by GitHub Copilot Chat. Update as GitHub adds or removes models.
const COPILOT_MODELS: { id: string; label: string }[] = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini" },
  { id: "o1-preview", label: "o1 Preview" },
  { id: "o1-mini", label: "o1 Mini" },
  { id: "claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
];

type CopilotTokenCache = {
  token: string;
  expiresAt: number;
};

let tokenCache: CopilotTokenCache | null = null;

function createRateLimiter(maxRequests: number, windowMs: number) {
  const requests = new Map<string, number[]>();
  return {
    check(key: string): boolean {
      const now = Date.now();
      const windowStart = now - windowMs;
      const recent = (requests.get(key) ?? []).filter((ts) => ts > windowStart);
      if (recent.length >= maxRequests) return false;
      recent.push(now);
      requests.set(key, recent);
      return true;
    },
  };
}

// Rate limit: 60 requests per minute per IP for auth-protected routes
const gatewayRateLimiter = createRateLimiter(60, 60_000);

function resolveGitHubToken(): string | null {
  return (
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    null
  );
}

function resolveGatewayAuthToken(): string | null {
  return process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN?.trim() || null;
}

function resolveCopilotApiBase(): string {
  return (
    process.env.PAPERCLIP_COPILOT_GATEWAY_API_BASE?.trim().replace(/\/$/, "") ||
    COPILOT_CHAT_API_BASE
  );
}

async function exchangeGitHubTokenForCopilotToken(githubToken: string): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + TOKEN_CACHE_REFRESH_BUFFER_MS) {
    return tokenCache.token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
  try {
    const response = await fetch(COPILOT_TOKEN_EXCHANGE_URL, {
      method: "GET",
      headers: {
        authorization: `token ${githubToken}`,
        "user-agent": COPILOT_EDITOR_PLUGIN_VERSION,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { token?: string; expires_at?: string };
    const token = data.token?.trim();
    if (!token) return null;
    const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : now + DEFAULT_COPILOT_TOKEN_TTL_MS;
    tokenCache = { token, expiresAt };
    return token;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCopilotBearerToken(githubToken: string): Promise<string> {
  const exchanged = await exchangeGitHubTokenForCopilotToken(githubToken);
  return exchanged ?? githubToken;
}

export function resetCopilotTokenCacheForTests(): void {
  tokenCache = null;
}

function checkRateLimit(req: Request, res: Response): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  if (!gatewayRateLimiter.check(ip)) {
    res.status(429).json({ error: "Too many requests" });
    return false;
  }
  return true;
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

function buildCopilotHeaders(bearerToken: string, extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${bearerToken}`,
    "content-type": "application/json",
    "editor-version": COPILOT_EDITOR_VERSION,
    "editor-plugin-version": COPILOT_EDITOR_PLUGIN_VERSION,
    "copilot-integration-id": "copilot-chat",
    "user-agent": COPILOT_EDITOR_PLUGIN_VERSION,
    ...extra,
  };
}

async function callCopilotChat(input: {
  bearerToken: string;
  apiBase: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
}): Promise<{ summary: string; model: string; inputTokens: number; outputTokens: number }> {
  const { bearerToken, apiBase, model, messages, timeoutMs } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: buildCopilotHeaders(bearerToken, { accept: "application/json" }),
      body: JSON.stringify({ model, messages }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Copilot Chat API error ${response.status}: ${text.slice(0, ERROR_MESSAGE_MAX_LENGTH)}`);
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
      model: data.model ?? model,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function streamCopilotChat(input: {
  bearerToken: string;
  apiBase: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  res: Response;
}): Promise<void> {
  const { bearerToken, apiBase, model, messages, timeoutMs, res } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let summary = "";
  let responseModel = model;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: buildCopilotHeaders(bearerToken, { accept: "text/event-stream" }),
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      res.write(`data: ${JSON.stringify({ type: "error", message: `Copilot Chat API error ${response.status}: ${text.slice(0, ERROR_MESSAGE_MAX_LENGTH)}` })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (!response.body) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Copilot Chat API returned no body" })}\n\n`);
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
      provider: "copilot",
      model: responseModel,
      usage: { inputTokens, outputTokens },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

export function copilotGatewayRoutes() {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/models", (req, res) => {
    if (!checkRateLimit(req, res)) return;
    const requiredToken = resolveGatewayAuthToken();
    if (requiredToken && !checkAuth(req, res, requiredToken)) return;

    const githubToken = resolveGitHubToken();
    if (!githubToken) {
      res.json([]);
      return;
    }
    res.json(COPILOT_MODELS);
  });

  router.post("/chat", async (req, res) => {
    if (!checkRateLimit(req, res)) return;
    const requiredToken = resolveGatewayAuthToken();
    if (requiredToken && !checkAuth(req, res, requiredToken)) return;

    const githubToken = resolveGitHubToken();
    if (!githubToken) {
      res.status(503).json({
        error: "No GitHub token configured. Set PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.",
      });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const messages = normalizeMessages(body.messages);
    if (messages.length === 0) {
      res.status(400).json({ error: "messages array is required and must not be empty" });
      return;
    }

    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_COPILOT_MODEL;
    const timeoutSec = typeof body.timeoutSec === "number" ? body.timeoutSec : DEFAULT_TIMEOUT_SEC;
    const timeoutMs = timeoutSec * 1000;
    const apiBase = resolveCopilotApiBase();

    try {
      const bearerToken = await resolveCopilotBearerToken(githubToken);
      const result = await callCopilotChat({ bearerToken, apiBase, model, messages, timeoutMs });
      res.json({
        summary: result.summary,
        provider: "copilot",
        model: result.model,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/chat/stream", async (req, res) => {
    if (!checkRateLimit(req, res)) return;
    const requiredToken = resolveGatewayAuthToken();
    if (requiredToken && !checkAuth(req, res, requiredToken)) return;

    const githubToken = resolveGitHubToken();
    if (!githubToken) {
      res.setHeader("content-type", "text/event-stream");
      res.write(
        `data: ${JSON.stringify({ type: "error", message: "No GitHub token configured. Set PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN." })}\n\n`,
      );
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

    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_COPILOT_MODEL;
    const timeoutSec = typeof body.timeoutSec === "number" ? body.timeoutSec : DEFAULT_TIMEOUT_SEC;
    const timeoutMs = timeoutSec * 1000;
    const apiBase = resolveCopilotApiBase();

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");

    try {
      const bearerToken = await resolveCopilotBearerToken(githubToken);
      await streamCopilotChat({ bearerToken, apiBase, model, messages, timeoutMs, res });
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
