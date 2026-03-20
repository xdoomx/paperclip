import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asStringArray,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
import { parseCopilotJsonl } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const COPILOT_AUTH_REQUIRED_RE =
  /(?:authentication\s+required|not\s+authenticated|not\s+logged\s+in|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|github[_\s-]?token|gh\s+auth\s+login|run\s+'?gh\s+auth'?\s+first)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "gh");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "copilot_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "copilot_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install the GitHub CLI (https://cli.github.com) and the gh copilot extension (`gh extension install github/gh-copilot`).",
    });
  }

  const configGhToken = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  const hostGhToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (isNonEmpty(configGhToken) || isNonEmpty(hostGhToken)) {
    const source = isNonEmpty(configGhToken) ? "adapter config env" : "server environment";
    checks.push({
      code: "copilot_gh_token_present",
      level: "info",
      message: "GH_TOKEN / GITHUB_TOKEN is set for GitHub authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "copilot_gh_token_missing",
      level: "warn",
      message:
        "GH_TOKEN / GITHUB_TOKEN is not set. Copilot runs may fail until authentication is configured.",
      hint: "Set GH_TOKEN in adapter env or run `gh auth login`.",
    });
  }

  const canRunProbe =
    checks.every(
      (check) =>
        check.code !== "copilot_cwd_invalid" && check.code !== "copilot_command_unresolvable",
    );
  if (canRunProbe) {
    if (!commandLooksLike(command, "gh")) {
      checks.push({
        code: "copilot_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `gh`.",
        detail: command,
        hint: "Use the `gh` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, DEFAULT_COPILOT_LOCAL_MODEL).trim();
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const args = [
        "copilot",
        "agent",
        "-p",
        "--output-format",
        "stream-json",
        "--workspace",
        cwd,
      ];
      if (model) args.push("--model", model);
      args.push("--yolo");
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("Respond with hello.");

      const probe = await runChildProcess(
        `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const parsed = parseCopilotJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "copilot_hello_probe_timed_out",
          level: "warn",
          message: "Copilot hello probe timed out.",
          hint: 'Retry the probe. If this persists, verify `gh copilot agent -p --output-format stream-json "Respond with hello."` manually.',
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "copilot_hello_probe_passed" : "copilot_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Copilot hello probe succeeded."
            : "Copilot probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: 'Try `gh copilot agent -p --output-format stream-json "Respond with hello."` manually to inspect full output.',
              }),
        });
      } else if (COPILOT_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "copilot_hello_probe_auth_required",
          level: "warn",
          message: "GitHub Copilot CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `gh auth login` or configure GH_TOKEN in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "copilot_hello_probe_failed",
          level: "error",
          message: "Copilot hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: 'Run `gh copilot agent -p --output-format stream-json "Respond with hello."` manually in this working directory to debug.',
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
