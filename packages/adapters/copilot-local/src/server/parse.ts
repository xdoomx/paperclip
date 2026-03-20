import { asString, parseJson } from "@paperclipai/adapter-utils/server-utils";

export interface ParsedCopilotOutput {
  suggestion: string | null;
  summary: string;
  errorMessage: string | null;
}

const WELCOME_RE = /^Welcome to GitHub Copilot in the CLI/i;
const VERSION_RE = /^version\s+[\d.]+/i;
const DISCLAIMER_RE = /I'm powered by AI/i;
const SHARE_FEEDBACK_RE = /Make sure to verify|share feedback/i;
const MORE_INFO_RE = /^For more information/i;
const SELECT_OPTION_RE = /^\?\s+Select an option/i;
const ARROWS_HINT_RE = /Use arrows to move/i;
const COPILOT_PROMPT_RE = /^\?\s+What kind of command/i;

const NOISE_LINE_RE = new RegExp(
  [
    WELCOME_RE.source,
    VERSION_RE.source,
    DISCLAIMER_RE.source,
    SHARE_FEEDBACK_RE.source,
    MORE_INFO_RE.source,
    SELECT_OPTION_RE.source,
    ARROWS_HINT_RE.source,
    COPILOT_PROMPT_RE.source,
    // Menu items from interactive prompt
    "^>\\s+(?:Copy command to clipboard|Explain command|Revise command|Rate response|Exit)$",
    // Blank selection indicator
    "^\\s*[>❯]\\s*$",
  ].join("|"),
  "i",
);

/**
 * Extract suggestion text from `gh copilot suggest` stdout.
 *
 * The output can take two forms depending on version and TTY state:
 *
 * 1. Structured JSON (newer versions with --output json):
 *    {"type":"suggestion","text":"git branch -a"}
 *
 * 2. Plain text (default, terminal-oriented output):
 *    Welcome to GitHub Copilot in the CLI!
 *    ...
 *    Suggestion:
 *
 *      git branch -a
 *
 *    ? Select an option...
 */
function extractSuggestionText(stdout: string): string {
  const lines = stdout.split(/\r?\n/);

  // Try JSON lines first (newer versions may emit JSON)
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    const parsed = parseJson(line);
    if (!parsed) continue;
    const suggestionText = asString(parsed.text, "").trim() || asString(parsed.suggestion, "").trim();
    if (suggestionText) return suggestionText;
    const errorText = asString(parsed.error, "").trim();
    if (errorText) return "";
  }

  // Try extracting from "Suggestion:\n\n  <text>" block
  const suggestionIdx = lines.findIndex((line) =>
    /^suggestion:?\s*$/i.test(line.trim()),
  );
  if (suggestionIdx >= 0) {
    const afterSuggestion: string[] = [];
    for (let i = suggestionIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      // Stop at interactive prompt markers or menu entries
      if (SELECT_OPTION_RE.test(trimmed) || ARROWS_HINT_RE.test(trimmed)) break;
      if (trimmed.startsWith("?")) break;
      afterSuggestion.push(trimmed);
    }
    const text = afterSuggestion.filter(Boolean).join("\n").trim();
    if (text) return text;
  }

  // Fall back: strip known noise lines and return remaining content
  const meaningful = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !NOISE_LINE_RE.test(l));

  return meaningful.join("\n").trim();
}

export function parseCopilotOutput(stdout: string, stderr: string): ParsedCopilotOutput {
  const suggestion = extractSuggestionText(stdout) || null;

  // Detect error messages from stderr or JSON error events
  let errorMessage: string | null = null;

  const stderrLines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of stderrLines) {
    if (line.length > 0 && !VERSION_RE.test(line) && !DISCLAIMER_RE.test(line)) {
      const parsed = parseJson(line);
      if (parsed) {
        const msg = asString(parsed.error, "").trim() || asString(parsed.message, "").trim();
        if (msg) {
          errorMessage = msg;
          break;
        }
      } else if (/^(error|fatal|fail|unauthorized|denied|not found)[:\s]/i.test(line)) {
        errorMessage = line;
        break;
      }
    }
  }

  // If no suggestion could be extracted and there's no explicit error,
  // try stderr as fallback for the summary
  const summary = suggestion ?? stderr.trim();

  return {
    suggestion,
    summary,
    errorMessage,
  };
}

export function isCopilotAuthError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  return /not (logged|authenticated|authorized)|authentication required|unauthorized|please (log in|authenticate|run `gh auth)/i.test(
    haystack,
  );
}
