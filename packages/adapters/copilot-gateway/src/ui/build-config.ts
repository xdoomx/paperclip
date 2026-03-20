import type { CreateConfigValues } from "@paperclipai/adapter-utils";

const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_STREAM = false;

export function buildCopilotGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  if (v.model) ac.model = v.model;
  ac.timeoutSec = DEFAULT_TIMEOUT_SEC;
  ac.stream = DEFAULT_STREAM;
  return ac;
}
