import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

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

function parseModelList(data: unknown): { id: string; label: string }[] {
  if (!Array.isArray(data)) return [];
  const out: { id: string; label: string }[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const id = nonEmpty(rec.id) ?? nonEmpty(rec.name);
    if (!id) continue;
    const label = nonEmpty(rec.label) ?? nonEmpty(rec.displayName) ?? id;
    out.push({ id, label });
  }
  return out;
}

export async function listCopilotGatewayModels(
  config: Record<string, unknown>,
): Promise<{ id: string; label: string }[]> {
  const urlValue = asString(config.url, "").trim();
  if (!urlValue) return [];

  let baseUrl: string;
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
    baseUrl = parsed.toString().replace(/\/$/, "");
  } catch {
    return [];
  }

  const authToken = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  const extraHeaders = toStringRecord(config.headers);

  const headers: Record<string, string> = {
    accept: "application/json",
    ...extraHeaders,
  };
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const json = await response.json().catch(() => null);
    // Support { models: [...] } or a bare array
    const list = Array.isArray(json)
      ? json
      : Array.isArray((json as Record<string, unknown>)?.models)
        ? (json as Record<string, unknown>).models
        : null;
    return list ? parseModelList(list) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
