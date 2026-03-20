import { describe, expect, it } from "vitest";
import { isCopilotUnknownSessionError, parseCopilotJsonl } from "@paperclipai/adapter-copilot-local/server";
import { parseCopilotStdoutLine } from "@paperclipai/adapter-copilot-local/ui";
import { printCopilotStreamEvent } from "@paperclipai/adapter-copilot-local/cli";

describe("copilot parser", () => {
  it("extracts session, summary, usage, and terminal error message", () => {
    const stdout = [
      JSON.stringify({ type: "system", session_id: "copilot_session_123", model: "gpt-4o" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "output_text", text: "hello from copilot" }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "copilot_session_123",
        usage: {
          input_tokens: 150,
          cached_input_tokens: 30,
          output_tokens: 50,
        },
        total_cost_usd: 0.002,
        result: "Task complete",
      }),
      JSON.stringify({ type: "error", message: "rate limit exceeded" }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBe("copilot_session_123");
    expect(parsed.summary).toBe("hello from copilot");
    expect(parsed.usage).toEqual({
      inputTokens: 150,
      cachedInputTokens: 30,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.002, 6);
    expect(parsed.errorMessage).toBe("rate limit exceeded");
  });

  it("extracts session_id from alternate field names", () => {
    const stdout = [
      JSON.stringify({ type: "init", sessionId: "alt_session_abc", model: "gpt-4.1" }),
      JSON.stringify({ type: "message", text: "alt hello" }),
      JSON.stringify({ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.sessionId).toBe("alt_session_abc");
    expect(parsed.summary).toBe("alt hello");
    expect(parsed.usage.inputTokens).toBe(10);
    expect(parsed.usage.outputTokens).toBe(5);
  });

  it("accumulates tokens across multiple result events", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 50, output_tokens: 20, cached_input_tokens: 10 },
      }),
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 30, output_tokens: 15, cached_input_tokens: 5 },
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(80);
    expect(parsed.usage.outputTokens).toBe(35);
    expect(parsed.usage.cachedInputTokens).toBe(15);
  });

  it("handles turn.completed event for usage", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "output_text", text: "hello via turn" }] } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 200, output_tokens: 80, cached_input_tokens: 40 },
        total_cost_usd: 0.005,
      }),
    ].join("\n");

    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.summary).toBe("hello via turn");
    expect(parsed.usage.inputTokens).toBe(200);
    expect(parsed.usage.outputTokens).toBe(80);
  });

  it("falls back to thread_id and conversationId for session", () => {
    const stdoutWithThreadId = JSON.stringify({ type: "system", thread_id: "thread_xyz" });
    expect(parseCopilotJsonl(stdoutWithThreadId).sessionId).toBe("thread_xyz");

    const stdoutWithConvId = JSON.stringify({ type: "system", conversationId: "conv_abc" });
    expect(parseCopilotJsonl(stdoutWithConvId).sessionId).toBe("conv_abc");
  });

  it("returns undefined costUsd when no cost is present", () => {
    const stdout = JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 5 } });
    const parsed = parseCopilotJsonl(stdout);
    expect(parsed.costUsd).toBeUndefined();
  });
});

describe("copilot stale session detection", () => {
  it("detects unknown session errors", () => {
    expect(isCopilotUnknownSessionError("unknown session id copilot_123", "")).toBe(true);
    expect(isCopilotUnknownSessionError("", "conversation abc not found")).toBe(true);
    expect(isCopilotUnknownSessionError("", "thread abc not found")).toBe(true);
    expect(isCopilotUnknownSessionError("unknown conversation", "")).toBe(true);
    expect(isCopilotUnknownSessionError("", "could not resume session")).toBe(true);
  });

  it("returns false for non-session errors", () => {
    expect(isCopilotUnknownSessionError("rate limit exceeded", "")).toBe(false);
    expect(isCopilotUnknownSessionError("", "authentication required")).toBe(false);
  });
});

describe("copilot session codec", () => {
  it("round-trips session params", async () => {
    const { sessionCodec } = await import("@paperclipai/adapter-copilot-local/server");
    const params = { sessionId: "test_session_1", cwd: "/some/dir" };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual({ sessionId: "test_session_1", cwd: "/some/dir" });
    const deserialized = sessionCodec.deserialize(serialized);
    expect(deserialized).toEqual({ sessionId: "test_session_1", cwd: "/some/dir" });
  });

  it("returns null when sessionId is missing", async () => {
    const { sessionCodec } = await import("@paperclipai/adapter-copilot-local/server");
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.serialize({})).toBeNull();
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
  });

  it("extracts displayId from sessionId", async () => {
    const { sessionCodec } = await import("@paperclipai/adapter-copilot-local/server");
    expect(sessionCodec.getDisplayId?.({ sessionId: "display_abc" })).toBe("display_abc");
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });

  it("accepts alternate session field names in deserialize", async () => {
    const { sessionCodec } = await import("@paperclipai/adapter-copilot-local/server");
    expect(sessionCodec.deserialize({ session_id: "abc" })).toEqual({ sessionId: "abc" });
  });
});

describe("copilot ui stdout parser", () => {
  it("parses init events", () => {
    const ts = "2026-03-20T00:00:00.000Z";
    const result = parseCopilotStdoutLine(
      JSON.stringify({ type: "system", session_id: "sess_1", model: "gpt-4o" }),
      ts,
    );
    expect(result).toEqual([
      { kind: "init", ts, model: "gpt-4o", sessionId: "sess_1" },
    ]);
  });

  it("parses assistant message with content array", () => {
    const ts = "2026-03-20T00:00:00.000Z";
    const result = parseCopilotStdoutLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "output_text", text: "I will run a command." },
            { type: "thinking", text: "Checking repository state" },
            { type: "tool_call", name: "bash", id: "tool_1", input: { command: "ls -1" } },
            { type: "tool_result", tool_use_id: "tool_1", output: "AGENTS.md\n", status: "ok" },
          ],
        },
      }),
      ts,
    );
    expect(result).toEqual([
      { kind: "assistant", ts, text: "I will run a command." },
      { kind: "thinking", ts, text: "Checking repository state" },
      { kind: "tool_call", ts, name: "bash", toolUseId: "tool_1", input: { command: "ls -1" } },
      { kind: "tool_result", ts, toolUseId: "tool_1", content: "AGENTS.md\n", isError: false },
    ]);
  });

  it("parses result events with usage", () => {
    const ts = "2026-03-20T00:00:00.000Z";
    const result = parseCopilotStdoutLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cached_input_tokens: 20,
        },
        total_cost_usd: 0.003,
        result: "Done",
        is_error: false,
        errors: [],
      }),
      ts,
    );
    expect(result).toEqual([
      {
        kind: "result",
        ts,
        text: "Done",
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 20,
        costUsd: 0.003,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("parses error events", () => {
    const ts = "2026-03-20T00:00:00.000Z";
    const result = parseCopilotStdoutLine(
      JSON.stringify({ type: "error", message: "model not available" }),
      ts,
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("result");
    expect((result[0] as { isError?: boolean }).isError).toBe(true);
  });

  it("falls back to stdout entry for non-JSON lines", () => {
    const ts = "2026-03-20T00:00:00.000Z";
    const result = parseCopilotStdoutLine("plain text line", ts);
    expect(result).toEqual([{ kind: "stdout", ts, text: "plain text line" }]);
  });

  it("returns empty for blank lines", () => {
    const ts = "2026-03-20T00:00:00.000Z";
    expect(parseCopilotStdoutLine("", ts)).toEqual([]);
    expect(parseCopilotStdoutLine("   ", ts)).toEqual([]);
  });
});

describe("copilot config builder", () => {
  it("builds adapter config from form values", async () => {
    const { buildCopilotLocalConfig } = await import("@paperclipai/adapter-copilot-local/ui");
    const config = buildCopilotLocalConfig({
      cwd: "/my/project",
      model: "gpt-4.1",
      instructionsFilePath: "/my/project/AGENTS.md",
      promptTemplate: "Do {{context.task}}",
      envVars: "",
      envBindings: undefined,
      thinkingEffort: "",
      search: false,
      dangerouslyBypassSandbox: false,
      bootstrapPrompt: "",
      command: "",
      extraArgs: "",
      workspaceStrategyType: "",
      workspaceBaseRef: "",
      workspaceBranchTemplate: "",
      worktreeParentDir: "",
      runtimeServicesJson: "",
    });
    expect(config.cwd).toBe("/my/project");
    expect(config.model).toBe("gpt-4.1");
    expect(config.instructionsFilePath).toBe("/my/project/AGENTS.md");
    expect(config.promptTemplate).toBe("Do {{context.task}}");
    expect(config.timeoutSec).toBe(0);
    expect(config.graceSec).toBe(15);
  });

  it("falls back to default model when no model provided", async () => {
    const { buildCopilotLocalConfig } = await import("@paperclipai/adapter-copilot-local/ui");
    const { DEFAULT_COPILOT_LOCAL_MODEL } = await import("@paperclipai/adapter-copilot-local");
    const config = buildCopilotLocalConfig({
      cwd: "",
      model: "",
      instructionsFilePath: "",
      promptTemplate: "",
      envVars: "",
      envBindings: undefined,
      thinkingEffort: "",
      search: false,
      dangerouslyBypassSandbox: false,
      bootstrapPrompt: "",
      command: "",
      extraArgs: "",
      workspaceStrategyType: "",
      workspaceBaseRef: "",
      workspaceBranchTemplate: "",
      worktreeParentDir: "",
      runtimeServicesJson: "",
    });
    expect(config.model).toBe(DEFAULT_COPILOT_LOCAL_MODEL);
  });
});

describe("copilot cli formatter", () => {
  it("does not throw on known event types", () => {
    const events = [
      JSON.stringify({ type: "system", session_id: "s1", model: "gpt-4o" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "output_text", text: "hi" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", usage: {}, total_cost_usd: 0 }),
      JSON.stringify({ type: "error", message: "oops" }),
      "non-json-line",
    ];
    for (const event of events) {
      expect(() => printCopilotStreamEvent(event, false)).not.toThrow();
    }
  });
});
