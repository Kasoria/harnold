import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";

export const isSecretInputRequest = (toolName: string) => toolName === "SecretInput";

type SecretInputRequest = { key?: string; description?: string; secret?: boolean; scope?: "project" | "environment"; file?: string; environmentName?: string };

/**
 * The agent asks for a secret (API key etc.). The value goes straight to Harnold's core and into the
 * environment's variables – not into the chat, not to the agent.
 */
export function SecretInputCard(props: { input: unknown; onSubmit: (value: string) => void; onCancel: () => void }) {
  const request = (props.input ?? {}) as SecretInputRequest;
  const [value, setValue] = useState("");
  const submit = () => value.trim() && props.onSubmit(value.trim());
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 rounded-xl border bg-card p-3 shadow-xs duration-200">
      <div className="flex items-center gap-2 text-[13px]">
        <KeyRound className="size-4 text-status-waiting" />
        <span>
          <strong className="font-medium">{request.key}</strong> {t("wird benötigt")}
        </span>
      </div>
      {request.description && <p className="mt-1 text-[13px] text-muted-foreground">{request.description}</p>}
      <Input
        className="mt-2"
        type={request.secret === false ? "text" : "password"}
        autoComplete="off"
        autoFocus
        value={value}
        placeholder={request.key}
        onChange={(changeEvent) => setValue(changeEvent.target.value)}
        onKeyDown={(keyEvent) => keyEvent.key === "Enter" && submit()}
      />
      <p className="mt-1.5 text-[12px] text-muted-foreground">
        {request.scope === "environment"
          ? t("Wird in der Umgebung „{0}“ gespeichert – weder im Chatverlauf noch bei der KI.", request.environmentName ?? "")
          : t("Wird in „{0}“ im Projektordner gespeichert – nicht im Chatverlauf.", request.file ?? ".env")}
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          {t("Abbrechen")}
        </Button>
        <Button size="sm" disabled={!value.trim()} onClick={submit}>
          {t("Speichern")}
        </Button>
      </div>
    </div>
  );
}
