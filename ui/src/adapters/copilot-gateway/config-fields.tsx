import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function SecretField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={placeholder}
        />
      </div>
    </Field>
  );
}

export function CopilotGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Gateway URL" hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://127.0.0.1:8080"
        />
      </Field>

      {!isCreate && (
        <>
          <Field label="Model">
            <DraftInput
              value={eff("adapterConfig", "model", String(config.model ?? ""))}
              onCommit={(v) => mark("adapterConfig", "model", v || undefined)}
              immediate
              className={inputClass}
              placeholder="gpt-4o"
            />
          </Field>

          <SecretField
            label="Auth token"
            value={eff("adapterConfig", "authToken", String(config.authToken ?? ""))}
            onCommit={(v) => mark("adapterConfig", "authToken", v || undefined)}
            placeholder="Bearer token for gateway authentication"
          />

          <Field label="Streaming">
            <select
              value={String(eff("adapterConfig", "stream", String(config.stream ?? "false")))}
              onChange={(e) => mark("adapterConfig", "stream", e.target.value === "true")}
              className={inputClass}
            >
              <option value="false">Disabled</option>
              <option value="true">Enabled (SSE)</option>
            </select>
          </Field>

          <Field label="Timeout (seconds)">
            <DraftInput
              value={eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? "120"))}
              onCommit={(v) => {
                const parsed = Number.parseInt(v.trim(), 10);
                mark(
                  "adapterConfig",
                  "timeoutSec",
                  Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                );
              }}
              immediate
              className={inputClass}
              placeholder="120"
            />
          </Field>
        </>
      )}
    </>
  );
}
