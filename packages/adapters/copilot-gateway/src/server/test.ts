import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function buildAuthHeaders(authToken: string | null): Record<string, string> {
  if (!authToken) return {};
  return { authorization: `Bearer ${authToken}` };
}

async function probeHealth(input: {
  baseUrl: string;
  authHeaders: Record<string, string>;
  extraHeaders: Record<string, string>;
  timeoutMs: number;
}): Promise<"ok" | "auth_required" | "failed"> {
  const { baseUrl, authHeaders, extraHeaders, timeoutMs } = input;
  const url = `${baseUrl}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...authHeaders,
        ...extraHeaders,
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return "auth_required";
    if (response.ok) return "ok";
    return "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "").trim();

  if (!urlValue) {
    checks.push({
      code: "copilot_gateway_url_missing",
      level: "error",
      message: "Copilot gateway adapter requires a URL.",
      hint: "Set adapterConfig.url to an http:// or https:// gateway base URL.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "copilot_gateway_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "http:" && url.protocol !== "https:") {
    checks.push({
      code: "copilot_gateway_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use http:// or https://.",
    });
  }

  if (url) {
    const baseUrl = url.toString().replace(/\/$/, "");
    checks.push({
      code: "copilot_gateway_url_valid",
      level: "info",
      message: `Configured gateway URL: ${baseUrl}`,
    });

    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      checks.push({
        code: "copilot_gateway_plaintext_remote",
        level: "warn",
        message: "Gateway URL uses plaintext http:// on a non-loopback host.",
        hint: "Prefer https:// for remote gateways.",
      });
    }
  }

  const authToken = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  const extraHeaders = toStringRecord(config.headers);

  if (authToken) {
    checks.push({
      code: "copilot_gateway_auth_present",
      level: "info",
      message: "Gateway auth token is configured.",
    });
  } else {
    checks.push({
      code: "copilot_gateway_auth_missing",
      level: "warn",
      message: "No gateway auth token detected in adapter config.",
      hint: "Set authToken if your gateway requires authentication.",
    });
  }

  if (url && (url.protocol === "http:" || url.protocol === "https:")) {
    const baseUrl = url.toString().replace(/\/$/, "");
    const authHeaders = buildAuthHeaders(authToken);
    try {
      const probeResult = await probeHealth({
        baseUrl,
        authHeaders,
        extraHeaders,
        timeoutMs: 4_000,
      });

      if (probeResult === "ok") {
        checks.push({
          code: "copilot_gateway_health_ok",
          level: "info",
          message: "Gateway /health probe succeeded.",
        });
      } else if (probeResult === "auth_required") {
        checks.push({
          code: "copilot_gateway_health_auth_required",
          level: "warn",
          message: "Gateway /health probe returned an auth error (401/403).",
          hint: "Check the authToken setting.",
        });
      } else {
        checks.push({
          code: "copilot_gateway_health_failed",
          level: "warn",
          message: "Gateway /health probe failed or returned an unexpected response.",
          hint: "Verify the gateway is running and reachable from the Paperclip server host.",
        });
      }
    } catch (err) {
      checks.push({
        code: "copilot_gateway_health_error",
        level: "warn",
        message: err instanceof Error ? err.message : "Gateway health probe failed",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
