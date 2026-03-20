import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { copilotGatewayRoutes, resetCopilotTokenCacheForTests } from "../routes/copilot-gateway.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/copilot-gateway", copilotGatewayRoutes());
  return app;
}

function mockExchangeSuccess(fetchSpy: ReturnType<typeof vi.spyOn>) {
  fetchSpy.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      token: "copilot-token-abc",
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  } as Response);
}

function mockExchangeFailure(fetchSpy: ReturnType<typeof vi.spyOn>) {
  fetchSpy.mockResolvedValueOnce({ ok: false } as Response);
}

beforeEach(() => {
  resetCopilotTokenCacheForTests();
  delete process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN;
  delete process.env.PAPERCLIP_COPILOT_GATEWAY_API_BASE;
});

afterEach(() => {
  resetCopilotTokenCacheForTests();
  delete process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN;
  delete process.env.PAPERCLIP_COPILOT_GATEWAY_API_BASE;
  vi.restoreAllMocks();
});

describe("GET /copilot-gateway/health", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/copilot-gateway/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /copilot-gateway/models", () => {
  it("returns empty array when no GitHub token is configured", async () => {
    const app = createApp();
    const res = await request(app).get("/copilot-gateway/models");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns Copilot models when PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN is set", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    const app = createApp();
    const res = await request(app).get("/copilot-gateway/models");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("id");
    expect(res.body[0]).toHaveProperty("label");
    expect(res.body.some((m: { id: string }) => m.id === "gpt-4o")).toBe(true);
  });

  it("returns Copilot models when GH_TOKEN is set", async () => {
    process.env.GH_TOKEN = "ghp_test";
    const app = createApp();
    const res = await request(app).get("/copilot-gateway/models");
    expect(res.status).toBe(200);
    expect(res.body.some((m: { id: string }) => m.id === "gpt-4o")).toBe(true);
  });

  it("returns Copilot models when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    const app = createApp();
    const res = await request(app).get("/copilot-gateway/models");
    expect(res.status).toBe(200);
    expect(res.body.some((m: { id: string }) => m.id === "gpt-4o")).toBe(true);
  });

  it("requires auth when PAPERCLIP_COPILOT_GATEWAY_TOKEN is set", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN = "gateway-secret";
    const app = createApp();

    const unauthRes = await request(app).get("/copilot-gateway/models");
    expect(unauthRes.status).toBe(401);

    const authRes = await request(app)
      .get("/copilot-gateway/models")
      .set("Authorization", "Bearer gateway-secret");
    expect(authRes.status).toBe(200);
  });
});

describe("POST /copilot-gateway/chat", () => {
  it("returns 503 when no GitHub token is configured", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("No GitHub token configured");
  });

  it("returns 400 when messages is empty", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("messages");
  });

  it("returns 400 when messages is missing", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({});
    expect(res.status).toBe(400);
  });

  it("exchanges GitHub token then calls Copilot Chat API and returns copilot protocol response", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockExchangeSuccess(fetchSpy);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: "gpt-4o",
        choices: [{ message: { content: "Hello from Copilot" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as Response);

    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }] });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe("Hello from Copilot");
    expect(res.body.provider).toBe("copilot");
    expect(res.body.model).toBe("gpt-4o");
    expect(res.body.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Verify the chat call included Copilot-specific headers
    const chatCall = fetchSpy.mock.calls[1];
    const chatUrl = chatCall[0] as string;
    expect(chatUrl).toContain("githubcopilot.com");
    const chatInit = chatCall[1] as RequestInit;
    const headers = chatInit.headers as Record<string, string>;
    expect(headers["copilot-integration-id"]).toBe("copilot-chat");
    expect(headers["editor-version"]).toBe("paperclip/1.0");
  });

  it("falls back to using GitHub token directly when token exchange fails", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_direct";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockExchangeFailure(fetchSpy);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: "gpt-4o",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    } as Response);

    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }] });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // When exchange fails, should use the original GitHub token
    const chatCall = fetchSpy.mock.calls[1];
    const chatInit = chatCall[1] as RequestInit;
    const headers = chatInit.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ghp_direct");
  });

  it("uses the model specified in the request body", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    let capturedBody: Record<string, unknown> | null = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockExchangeFailure(fetchSpy);
    fetchSpy.mockImplementationOnce(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          model: "claude-3.5-sonnet",
          choices: [{ message: { content: "Response" } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      } as Response;
    });

    const app = createApp();
    await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }], model: "claude-3.5-sonnet" });

    expect(capturedBody?.model).toBe("claude-3.5-sonnet");
  });

  it("requires auth when PAPERCLIP_COPILOT_GATEWAY_TOKEN is set", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN = "gateway-secret";
    const app = createApp();

    const unauthRes = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }] });
    expect(unauthRes.status).toBe(401);
  });

  it("uses a custom API base when PAPERCLIP_COPILOT_GATEWAY_API_BASE is set", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    process.env.PAPERCLIP_COPILOT_GATEWAY_API_BASE = "https://custom.copilot.example.com";

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockExchangeFailure(fetchSpy);
    let capturedUrl = "";
    fetchSpy.mockImplementationOnce(async (url) => {
      capturedUrl = url as string;
      return {
        ok: true,
        json: async () => ({
          model: "gpt-4o",
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      } as Response;
    });

    const app = createApp();
    await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }] });

    expect(capturedUrl).toBe("https://custom.copilot.example.com/chat/completions");
  });

  it("passes the copilot request context fields transparently", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockExchangeFailure(fetchSpy);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: "gpt-4o",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    } as Response);

    const app = createApp();
    const res = await request(app).post("/copilot-gateway/chat").send({
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(res.status).toBe(200);
  });
});

describe("POST /copilot-gateway/chat/stream", () => {
  it("returns SSE error event when no GitHub token is configured", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat/stream")
      .set("Accept", "text/event-stream")
      .send({ messages: [{ role: "user", content: "Hello" }] });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain("data: [DONE]");
  });

  it("returns SSE error event when messages is empty", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat/stream")
      .set("Accept", "text/event-stream")
      .send({ messages: [] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"error"');
  });

  it("requires auth when PAPERCLIP_COPILOT_GATEWAY_TOKEN is set", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";
    process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN = "gateway-secret";
    const app = createApp();

    const unauthRes = await request(app)
      .post("/copilot-gateway/chat/stream")
      .send({ messages: [{ role: "user", content: "Hello" }] });
    expect(unauthRes.status).toBe(401);
  });

  it("streams Copilot Chat SSE and maps to copilot protocol", async () => {
    process.env.PAPERCLIP_COPILOT_GATEWAY_GITHUB_TOKEN = "ghp_test";

    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      "data: [DONE]",
    ].join("\n") + "\n";

    const encoder = new TextEncoder();
    const encoded = encoder.encode(sseLines);
    let offset = 0;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockExchangeFailure(fetchSpy);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (offset < encoded.length) {
              const chunk = encoded.slice(offset);
              offset = encoded.length;
              return { done: false, value: chunk };
            }
            return { done: true, value: undefined };
          },
          cancel: async () => {},
        }),
      },
    } as unknown as Response);

    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat/stream")
      .set("Accept", "text/event-stream")
      .send({ messages: [{ role: "user", content: "Hello" }] });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"delta"');
    expect(res.text).toContain('"type":"result"');
    expect(res.text).toContain('"provider":"copilot"');
    expect(res.text).toContain("data: [DONE]");
  });
});
