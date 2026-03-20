import type { UIAdapterModule } from "../types";
import { parseCopilotGatewayStdoutLine } from "@paperclipai/adapter-copilot-gateway/ui";
import { buildCopilotGatewayConfig } from "@paperclipai/adapter-copilot-gateway/ui";
import { CopilotGatewayConfigFields } from "./config-fields";

export const copilotGatewayUIAdapter: UIAdapterModule = {
  type: "copilot_gateway",
  label: "Copilot Gateway",
  parseStdoutLine: parseCopilotGatewayStdoutLine,
  ConfigFields: CopilotGatewayConfigFields,
  buildAdapterConfig: buildCopilotGatewayConfig,
};
