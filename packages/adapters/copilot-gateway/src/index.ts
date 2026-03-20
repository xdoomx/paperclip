export const type = "copilot_gateway";
export const label = "Copilot Gateway";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# copilot_gateway agent configuration

Adapter: copilot_gateway

Use when:
- You want Paperclip to invoke a Copilot-compatible chat gateway over HTTP.
- You want to route agent execution through a local or remote gateway that speaks the Copilot HTTP protocol.
- Your gateway exposes GET /health, GET /models, and POST /chat (or POST /chat/stream).

Don't use when:
- You need a WebSocket-based gateway (use openclaw_gateway instead).
- Your deployment does not permit outbound HTTP access from the Paperclip server.

Built-in gateway:
- Paperclip ships with a built-in Copilot-compatible gateway at /copilot-gateway on the Paperclip server.
- Set url to http://<paperclip-host>:<port>/copilot-gateway to use the built-in gateway without running a separate service.
- The built-in gateway requires OPENAI_API_KEY or ANTHROPIC_API_KEY (or llm config in paperclip.json) to process requests.
- Secure the built-in gateway with the optional PAPERCLIP_COPILOT_GATEWAY_TOKEN environment variable.

Core fields:
- url (string, required): Gateway base URL (http:// or https://)
- authToken (string, optional): Bearer token sent as Authorization header
- model (string, optional): Model ID to request from the gateway
- stream (boolean, optional): Enable SSE streaming via POST /chat/stream (default false)
- headers (object, optional): Additional HTTP headers to include in every request
- timeoutSec (number, optional): Request timeout in seconds (default 120)

Model discovery:
- The adapter calls GET /models on the configured URL to populate the model list.
- Each entry returned should have { id, label } or at minimum { id }.

Request format sent to POST /chat (or POST /chat/stream):
{
  "runId": "<run id>",
  "agentId": "<agent id>",
  "companyId": "<company id>",
  "taskId": "<task id or null>",
  "issueId": "<issue id or null>",
  "wakeReason": "<wake reason or null>",
  "model": "<model id>",
  "messages": [{ "role": "user", "content": "<wake text>" }],
  "context": { ... }
}

Expected response from POST /chat:
{
  "summary": "string (optional)",
  "provider": "string (optional)",
  "model": "string (optional)",
  "usage": { "inputTokens": 0, "outputTokens": 0 } (optional),
  "costUsd": 0 (optional)
}

Streaming response (POST /chat/stream) uses SSE:
- data: {"type":"delta","text":"..."} for incremental assistant output
- data: {"type":"result","summary":"...","provider":"...","model":"...","usage":{...},"costUsd":0} for final result
- data: {"type":"error","message":"..."} for errors
- data: [DONE] to signal end of stream
`;
