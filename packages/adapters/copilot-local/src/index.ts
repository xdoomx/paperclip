export const type = "copilot_local";
export const label = "GitHub Copilot (local)";
export const DEFAULT_COPILOT_LOCAL_MODEL = "gpt-4o";

export const models = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-opus-4", label: "Claude Opus 4" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- You want Paperclip to run the GitHub Copilot coding agent CLI locally as the agent runtime
- You want GitHub Copilot session resume across heartbeats via --session
- You want structured stream-json output in run logs

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- The GitHub Copilot CLI (gh copilot) is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Copilot model id (for example gpt-4o)
- command (string, optional): defaults to "gh"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs are executed with: gh copilot agent --output-format stream-json ...
- Prompts are piped to the agent via stdin.
- Sessions are resumed with --session when stored session cwd matches current cwd.
- Paperclip auto-adds --yolo unless one of --trust/--yolo/-f is already present in extraArgs.
`;
