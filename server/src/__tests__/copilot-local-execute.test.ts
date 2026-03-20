import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-copilot-local/server";

async function writeFakeGhCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
// Simulate gh copilot suggest output
process.stdout.write("Welcome to GitHub Copilot in the CLI!\\n");
process.stdout.write("version 1.0.5 (2024-04-04)\\n");
process.stdout.write("\\n");
process.stdout.write("Suggestion:\\n");
process.stdout.write("\\n");
process.stdout.write("  ls -la\\n");
process.stdout.write("\\n");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  paperclipEnvKeys: string[];
};

describe("copilot_local execute", () => {
  it("passes prompt as final argument and injects paperclip env vars", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-copilot-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gh");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGhCommand(commandPath);

    let invocationPrompt = "";
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Copilot Assistant",
          adapterType: "copilot_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          target: "shell",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "List all files.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationPrompt = meta.prompt ?? "";
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.summary).toBe("ls -la");

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      // Should invoke `gh copilot suggest --target shell <prompt>`
      expect(capture.argv[0]).toBe("copilot");
      expect(capture.argv[1]).toBe("suggest");
      expect(capture.argv).toContain("--target");
      expect(capture.argv).toContain("shell");
      expect(capture.argv.at(-1)).toContain("List all files.");

      // Should inject standard Paperclip env vars
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );

      expect(invocationPrompt).toContain("List all files.");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("defaults target to shell when not configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-copilot-target-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gh");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGhCommand(commandPath);

    try {
      await execute({
        runId: "run-2",
        agent: { id: "a1", companyId: "c1", name: "C", adapterType: "copilot_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--target");
      expect(capture.argv).toContain("shell");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
