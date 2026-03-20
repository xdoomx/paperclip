import { describe, expect, it, vi } from "vitest";
import { parseCopilotOutput, isCopilotAuthError } from "@paperclipai/adapter-copilot-local/server";
import { parseCopilotStdoutLine } from "@paperclipai/adapter-copilot-local/ui";
import { printCopilotStreamEvent } from "@paperclipai/adapter-copilot-local/cli";

describe("copilot_local parser", () => {
  it("extracts suggestion from Suggestion: header in plain text output", () => {
    const stdout = [
      "Welcome to GitHub Copilot in the CLI!",
      "version 1.0.5 (2024-04-04)",
      "",
      "I'm powered by AI, so surprises and mistakes are possible.",
      "",
      "Suggestion:",
      "",
      "  find . -mtime -1",
      "",
      "? Select an option",
      "> Copy command to clipboard",
    ].join("\n");

    const parsed = parseCopilotOutput(stdout, "");
    expect(parsed.suggestion).toBe("find . -mtime -1");
    expect(parsed.summary).toBe("find . -mtime -1");
    expect(parsed.errorMessage).toBeNull();
  });

  it("extracts suggestion from JSON line (newer versions)", () => {
    const stdout = [
      "Welcome to GitHub Copilot in the CLI!",
      JSON.stringify({ type: "suggestion", text: "git branch -a" }),
    ].join("\n");

    const parsed = parseCopilotOutput(stdout, "");
    expect(parsed.suggestion).toBe("git branch -a");
  });

  it("falls back to non-noise lines when no Suggestion header", () => {
    const stdout = [
      "Welcome to GitHub Copilot in the CLI!",
      "version 1.0.5",
      "ls -la",
    ].join("\n");

    const parsed = parseCopilotOutput(stdout, "");
    expect(parsed.suggestion).toBe("ls -la");
    expect(parsed.summary).toBe("ls -la");
  });

  it("returns null suggestion and uses stderr as summary when no useful stdout", () => {
    const stdout = [
      "Welcome to GitHub Copilot in the CLI!",
      "version 1.0.5",
    ].join("\n");

    const parsed = parseCopilotOutput(stdout, "Not authenticated.");
    expect(parsed.suggestion).toBeNull();
    expect(parsed.summary).toBe("Not authenticated.");
  });

  it("extracts error message from stderr", () => {
    const parsed = parseCopilotOutput(
      "Welcome to GitHub Copilot in the CLI!",
      "error: API rate limit exceeded",
    );
    expect(parsed.errorMessage).toBe("error: API rate limit exceeded");
  });

  it("handles multi-line suggestion block", () => {
    const stdout = [
      "Suggestion:",
      "",
      "  git log --oneline -10",
      "",
      "? Select an option",
    ].join("\n");

    const parsed = parseCopilotOutput(stdout, "");
    expect(parsed.suggestion).toBe("git log --oneline -10");
  });
});

describe("copilot_local auth error detection", () => {
  it("detects authentication errors from stdout", () => {
    expect(isCopilotAuthError("not logged in", "")).toBe(true);
    expect(isCopilotAuthError("", "authentication required")).toBe(true);
    expect(isCopilotAuthError("", "please run `gh auth login`")).toBe(true);
    expect(isCopilotAuthError("unauthorized access", "")).toBe(true);
  });

  it("returns false for non-auth errors", () => {
    expect(isCopilotAuthError("find . -mtime -1", "")).toBe(false);
    expect(isCopilotAuthError("", "git branch -a")).toBe(false);
    expect(isCopilotAuthError("", "")).toBe(false);
  });
});

describe("copilot_local ui stdout parser", () => {
  const ts = "2026-03-20T00:00:00.000Z";

  it("parses suggestion lines as assistant messages", () => {
    expect(parseCopilotStdoutLine("  find . -mtime -1", ts)).toEqual([
      { kind: "assistant", ts, text: "find . -mtime -1" },
    ]);
  });

  it("filters out welcome/noise lines", () => {
    expect(parseCopilotStdoutLine("Welcome to GitHub Copilot in the CLI!", ts)).toEqual([]);
    expect(parseCopilotStdoutLine("version 1.0.5 (2024-04-04)", ts)).toEqual([]);
    expect(parseCopilotStdoutLine("I'm powered by AI, so surprises and mistakes are possible.", ts)).toEqual([]);
    expect(parseCopilotStdoutLine("? Select an option", ts)).toEqual([]);
    expect(parseCopilotStdoutLine("> Copy command to clipboard", ts)).toEqual([]);
    expect(parseCopilotStdoutLine("Use arrows to move, type to filter", ts)).toEqual([]);
  });

  it("filters out Suggestion: header", () => {
    expect(parseCopilotStdoutLine("Suggestion:", ts)).toEqual([]);
    expect(parseCopilotStdoutLine("Suggestion", ts)).toEqual([]);
  });

  it("returns empty for blank lines", () => {
    expect(parseCopilotStdoutLine("", ts)).toEqual([]);
    expect(parseCopilotStdoutLine("   ", ts)).toEqual([]);
  });

  it("returns stdout entries for interactive prompt markers", () => {
    expect(parseCopilotStdoutLine("? What kind of command", ts)).toEqual([]);
    expect(parseCopilotStdoutLine("> some option", ts)).toEqual([
      { kind: "stdout", ts, text: "> some option" },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("copilot_local cli formatter", () => {
  it("prints suggestion content, filters noise, and formats errors", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let joined = "";

    try {
      printCopilotStreamEvent("Welcome to GitHub Copilot in the CLI!", false);
      printCopilotStreamEvent("version 1.0.5 (2024-04-04)", false);
      printCopilotStreamEvent("Suggestion:", false);
      printCopilotStreamEvent("  find . -mtime -1", false);
      printCopilotStreamEvent("error: API rate limit exceeded", false);
      printCopilotStreamEvent("[paperclip] Loaded agent instructions", false);
      joined = spy.mock.calls.map((call) => stripAnsi(call.join(" "))).join("\n");
    } finally {
      spy.mockRestore();
    }

    // Noise lines should be filtered
    expect(joined).not.toContain("Welcome to GitHub Copilot");
    expect(joined).not.toContain("version 1.0.5");

    // Suggestion header should print as label
    expect(joined).toContain("Copilot suggestion:");

    // Suggestion content should print as assistant
    expect(joined).toContain("assistant: find . -mtime -1");

    // Error lines should be highlighted
    expect(joined).toContain("error: error: API rate limit exceeded");

    // Paperclip internal lines
    expect(joined).toContain("[paperclip] Loaded agent instructions");
  });
});
