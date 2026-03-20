import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const NOISE_LINE_RE =
  /^(Welcome to GitHub Copilot|version\s+[\d.]+|I'm powered by AI|Make sure to verify|For more information|>\s*(Copy command|Explain command|Revise command|Rate response|Exit)|\?\s+Select an option|\?\s+What kind of command|Use arrows to move)/i;

/**
 * Parse a single stdout line from the copilot_local adapter into transcript entries.
 *
 * `gh copilot suggest` outputs plain text rather than JSON-L, so most lines are
 * treated as raw stdout entries. Lines that look like the Copilot welcome/noise
 * messages are filtered out. Lines following a "Suggestion:" header are surfaced
 * as assistant messages.
 */
export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // Filter known noise/UI chrome from gh copilot interactive output
  if (NOISE_LINE_RE.test(trimmed)) return [];

  // Suggestion header — not content itself
  if (/^suggestion:?\s*$/i.test(trimmed)) return [];

  // Lines that look like the extracted suggestion (indented or after the header)
  // are surfaced as assistant messages
  if (trimmed.length > 0 && !trimmed.startsWith("?") && !trimmed.startsWith(">")) {
    return [{ kind: "assistant", ts, text: trimmed }];
  }

  return [{ kind: "stdout", ts, text: trimmed }];
}
