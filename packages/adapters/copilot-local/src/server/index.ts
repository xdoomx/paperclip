import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { parseCopilotOutput, isCopilotAuthError } from "./parse.js";

/**
 * Session codec for the copilot_local adapter.
 *
 * GitHub Copilot (`gh copilot suggest`) does not support persistent sessions.
 * Each invocation is stateless. The codec is a no-op that always returns null.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(_raw: unknown): Record<string, unknown> | null {
    return null;
  },
  serialize(_params: Record<string, unknown> | null): Record<string, unknown> | null {
    return null;
  },
  getDisplayId(_params: Record<string, unknown> | null): string | null {
    return null;
  },
};
