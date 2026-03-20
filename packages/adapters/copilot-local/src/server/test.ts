import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parseCopilotOutput, isCopilotAuthError } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function commandLooksLikeGh(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === "gh" || base === "gh.exe" || base === "gh.cmd";
}

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
      hint: "Install GitHub CLI from https://cli.github.com/ and ensure it is in your PATH.",
    });
  }

  // Check gh auth status
  const hasGhToken =
    typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim().length > 0
      ? true
      : typeof process.env.GITHUB_TOKEN === "string" && process.env.GITHUB_TOKEN.trim().length > 0;

  if (hasGhToken) {
    const source = typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim().length > 0
      ? "adapter config env"
      : "server environment";
    checks.push({
      code: "copilot_github_token_present",
      level: "info",
      message: "GITHUB_TOKEN is set for GitHub CLI authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "copilot_github_token_missing",
      level: "info",
      message: "No explicit GITHUB_TOKEN detected. GitHub CLI will use its stored login credentials.",
      hint: "If the hello probe fails with an auth error, set GITHUB_TOKEN in adapter env or run `gh auth login`.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "copilot_cwd_invalid" && check.code !== "copilot_command_unresolvable");

  if (canRunProbe) {
    if (!commandLooksLikeGh(command)) {
      checks.push({
        code: "copilot_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `gh`.",
        detail: command,
        hint: "Use the `gh` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      // Probe: check if `gh copilot` extension is installed
      const extensionProbe = await runChildProcess(
        `copilot-envtest-ext-${Date.now()}`,
        command,
        ["extension", "list"],
        {
          cwd,
          env,
          timeoutSec: 15,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const extensionListOutput = `${extensionProbe.stdout}\n${extensionProbe.stderr}`.toLowerCase();
      const hasCopilotExtension =
        extensionListOutput.includes("gh-copilot") ||
        extensionListOutput.includes("copilot");

      if (extensionProbe.timedOut) {
        checks.push({
          code: "copilot_extension_probe_timed_out",
          level: "warn",
          message: "Timed out while checking installed gh extensions.",
          hint: "Run `gh extension list` manually to verify the copilot extension is installed.",
        });
      } else if ((extensionProbe.exitCode ?? 1) !== 0) {
        const isAuthError = isCopilotAuthError(extensionProbe.stdout, extensionProbe.stderr);
        checks.push({
          code: isAuthError ? "copilot_gh_auth_required" : "copilot_extension_list_failed",
          level: isAuthError ? "warn" : "error",
          message: isAuthError
            ? "GitHub CLI is installed but not authenticated."
            : "Failed to list gh extensions.",
          hint: isAuthError
            ? "Run `gh auth login` to authenticate, then retry."
            : "Run `gh extension list` manually to diagnose.",
        });
      } else if (!hasCopilotExtension) {
        checks.push({
          code: "copilot_extension_not_installed",
          level: "error",
          message: "GitHub Copilot CLI extension is not installed.",
          hint: "Install it with: gh extension install github/gh-copilot",
        });
      } else {
        checks.push({
          code: "copilot_extension_installed",
          level: "info",
          message: "GitHub Copilot CLI extension is installed.",
        });

        // Run a quick hello probe with `gh copilot suggest`
        const target = asString(config.target, "shell").trim() || "shell";
        const helloProbe = await runChildProcess(
          `copilot-envtest-hello-${Date.now()}`,
          command,
          ["copilot", "suggest", "--target", target, "list files in the current directory"],
          {
            cwd,
            env,
            timeoutSec: 30,
            graceSec: 5,
            onLog: async () => {},
          },
        );

        const helloOutput = parseCopilotOutput(helloProbe.stdout, helloProbe.stderr);
        const isAuthError = isCopilotAuthError(helloProbe.stdout, helloProbe.stderr);

        if (helloProbe.timedOut) {
          checks.push({
            code: "copilot_hello_probe_timed_out",
            level: "warn",
            message: "GitHub Copilot hello probe timed out.",
            hint: "Retry the probe. If this persists, verify `gh copilot suggest \"list files\"` works manually.",
          });
        } else if (isAuthError) {
          checks.push({
            code: "copilot_hello_probe_auth_required",
            level: "warn",
            message: "GitHub Copilot CLI extension is installed but authentication is not ready.",
            hint: "Run `gh auth login` or set GITHUB_TOKEN in adapter env, then retry.",
          });
        } else if ((helloProbe.exitCode ?? 1) === 0 && helloOutput.suggestion) {
          const short = helloOutput.suggestion.replace(/\s+/g, " ").trim().slice(0, 240);
          checks.push({
            code: "copilot_hello_probe_passed",
            level: "info",
            message: "GitHub Copilot hello probe succeeded.",
            detail: short,
          });
        } else if ((helloProbe.exitCode ?? 1) === 0) {
          checks.push({
            code: "copilot_hello_probe_no_suggestion",
            level: "warn",
            message: "Copilot probe ran successfully but returned no suggestion.",
            hint: "Try `gh copilot suggest \"list files\"` manually to inspect full output.",
          });
        } else {
          const detail = helloOutput.errorMessage?.slice(0, 240) ?? undefined;
          checks.push({
            code: "copilot_hello_probe_failed",
            level: "error",
            message: "GitHub Copilot hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `gh copilot suggest \"list files\"` manually in this working directory to debug.",
          });
        }
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
