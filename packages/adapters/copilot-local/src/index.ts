export const type = "copilot_local";
export const label = "GitHub Copilot (local)";
export const DEFAULT_COPILOT_LOCAL_MODEL = "copilot";

export const models = [
  { id: DEFAULT_COPILOT_LOCAL_MODEL, label: "GitHub Copilot (default)" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "claude-3.7-sonnet", label: "Claude 3.7 Sonnet" },
  { id: "o3-mini", label: "o3-mini" },
  { id: "o4-mini", label: "o4-mini" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- You want Paperclip to invoke GitHub Copilot locally via the \`gh copilot\` CLI extension.
- You want chat-style advisory responses from Copilot (suggestions, explanations, code hints).
- GitHub CLI (\`gh\`) is installed and authenticated on the host machine.
- You want to use GitHub Copilot as a conversational assistant for answering questions and providing shell/git/github command suggestions.

Don't use when:
- You need an agent that autonomously writes code, edits files, or runs multi-step tasks (use claude_local, codex_local, gemini_local, or opencode_local instead).
- You need webhook-style external invocation (use http or openclaw_gateway).
- The \`gh\` CLI is not installed or \`gh copilot\` extension is not available.

Core fields:
- cwd (string, optional): working directory for the \`gh\` command (created if missing when possible).
- promptTemplate (string, optional): run prompt template rendered with Paperclip context variables.
- target (string, optional): Copilot suggestion target — "shell" (default), "git", or "github".
- command (string, optional): override the command to invoke (defaults to "gh").
- env (object, optional): KEY=VALUE environment variables passed to the process.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds.
- graceSec (number, optional): SIGTERM grace period in seconds.

Notes:
- The adapter runs \`gh copilot suggest <prompt> --target <target>\` and captures the suggestion.
- Authentication is handled via the \`gh\` CLI's stored GitHub credentials.
- No session state is maintained between runs (each run is a fresh Copilot query).
- Set GITHUB_TOKEN in env to use a specific GitHub token for authentication.
`;
