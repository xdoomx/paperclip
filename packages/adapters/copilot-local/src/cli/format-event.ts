import pc from "picocolors";

const NOISE_LINE_RE =
  /^(Welcome to GitHub Copilot|version\s+[\d.]+|I'm powered by AI|Make sure to verify|For more information|>\s*(Copy command|Explain command|Revise command|Rate response|Exit)|\?\s+Select an option|\?\s+What kind of command|Use arrows to move)/i;

export function printCopilotStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  // Filter out known interactive UI chrome from gh copilot output
  if (NOISE_LINE_RE.test(line)) return;

  // Suggestion header line
  if (/^suggestion:?\s*$/i.test(line)) {
    console.log(pc.blue("Copilot suggestion:"));
    return;
  }

  // Error-looking lines
  if (/^error[:!]/i.test(line) || /\berror\b/i.test(line)) {
    console.log(pc.red(`error: ${line}`));
    return;
  }

  // Paperclip internal log lines
  if (line.startsWith("[paperclip]")) {
    console.log(pc.gray(line));
    return;
  }

  // Prompt / interactive markers (debug mode only)
  if (line.startsWith("?") || line.startsWith(">")) {
    if (debug) console.log(pc.gray(line));
    return;
  }

  // The actual suggestion content
  console.log(pc.green(`assistant: ${line}`));
}
