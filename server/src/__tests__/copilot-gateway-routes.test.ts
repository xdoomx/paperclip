import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { copilotGatewayRoutes } from "../routes/copilot-gateway.js";

vi.mock("../config-file.js", () => ({
  readConfigFile: vi.fn().mockReturnValue(null),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/copilot-gateway", copilotGatewayRoutes());
  return app;
}

describe("GET /copilot-gateway/health", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/copilot-gateway/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /copilot-gateway/models", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN;
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN;
    vi.restoreAllMocks();
  });

  it("returns empty array when no LLM is configured", async () => {
    const app = createApp();
    const res = await request(app).get("/copilot-gateway/models");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns openai models when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const app = createApp();
    const res = await request(app).get("/copilot-gateway/models");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("id");
    expect(res.body[0]).toHaveProperty("label");
    expect(res.body.some((m: { id: string }) => m.id === "gpt-4o")).toBe(true);
  });

  it("returns claude models when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const app = createApp();
    const res = await request(app).get("/copilot-gateway/models");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((m: { id: string }) => m.id.startsWith("claude-"))).toBe(true);
  });

  it("requires auth when PAPERCLIP_COPILOT_GATEWAY_TOKEN is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN = "secret-token";
    const app = createApp();

    const unauthRes = await request(app).get("/copilot-gateway/models");
    expect(unauthRes.status).toBe(401);

    const authRes = await request(app)
      .get("/copilot-gateway/models")
      .set("Authorization", "Bearer secret-token");
    expect(authRes.status).toBe(200);
  });
});

describe("POST /copilot-gateway/chat", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN;
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN;
    vi.restoreAllMocks();
  });

  it("returns 503 when no LLM is configured", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("No LLM provider configured");
  });

  it("returns 400 when messages is empty", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("messages");
  });

  it("returns 400 when messages is missing", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({});
    expect(res.status).toBe(400);
  });

  it("calls OpenAI and returns copilot protocol response", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: "gpt-4o",
        choices: [{ message: { content: "Hello from OpenAI" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    } as Response);

    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }] });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe("Hello from OpenAI");
    expect(res.body.provider).toBe("openai");
    expect(res.body.model).toBe("gpt-4o");
    expect(res.body.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("calls Claude and returns copilot protocol response", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: "claude-opus-4-5",
        content: [{ type: "text", text: "Hello from Claude" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    } as Response);

    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }] });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe("Hello from Claude");
    expect(res.body.provider).toBe("claude");
    expect(res.body.model).toBe("claude-opus-4-5");
    expect(res.body.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("requires auth when PAPERCLIP_COPILOT_GATEWAY_TOKEN is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN = "secret-token";
    const app = createApp();

    const unauthRes = await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }] });
    expect(unauthRes.status).toBe(401);
  });

  it("uses the model specified in the request body", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    let capturedBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          model: "gpt-4-turbo",
          choices: [{ message: { content: "Response" } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      } as Response;
    });

    const app = createApp();
    await request(app)
      .post("/copilot-gateway/chat")
      .send({ messages: [{ role: "user", content: "Hello" }], model: "gpt-4-turbo" });

    expect(capturedBody?.model).toBe("gpt-4-turbo");
  });

  it("passes the copilot request context fields through", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
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
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN;
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN;
    vi.restoreAllMocks();
  });

  it("returns SSE error event when no LLM is configured", async () => {
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
    process.env.OPENAI_API_KEY = "sk-test";
    const app = createApp();
    const res = await request(app)
      .post("/copilot-gateway/chat/stream")
      .set("Accept", "text/event-stream")
      .send({ messages: [] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"error"');
  });

  it("requires auth when PAPERCLIP_COPILOT_GATEWAY_TOKEN is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.PAPERCLIP_COPILOT_GATEWAY_TOKEN = "secret-token";
    const app = createApp();

    const unauthRes = await request(app)
      .post("/copilot-gateway/chat/stream")
      .send({ messages: [{ role: "user", content: "Hello" }] });
    expect(unauthRes.status).toBe(401);
  });

  it("streams OpenAI SSE and maps to copilot protocol", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      "data: [DONE]",
    ].join("\n") + "\n";

    const encoder = new TextEncoder();
    const encoded = encoder.encode(sseLines);
    let offset = 0;

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
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
    expect(res.text).toContain('"provider":"openai"');
    expect(res.text).toContain("data: [DONE]");
  });
});
