import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmAction } from "@/components/confirm-dialog";
import { t } from "@/lib/i18n";

/** Settings → General (local app only): moves projects, chats, memory, settings and secrets to a Harnold server. */
export function MigrateToServerSetting({ onError }: { onError: (error: unknown) => void }) {
  const [serverUrl, setServerUrl] = useState("");
  const [serverToken, setServerToken] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "done">("idle");

  const migrate = async () => {
    const confirmed = await confirmAction({
      title: t("Workspace auf den Server übertragen?"),
      description: t("Projekte, Chats, Memory, Einstellungen und Konten werden auf den Server kopiert. Dort vorhandene Daten werden ersetzt (ein Backup bleibt auf dem Server). Dein lokaler Workspace bleibt unverändert. Kanäle wie Telegram oder Postfächer danach nur auf einer Seite aktiv lassen. Claude- und Codex-Anmeldungen musst du auf dem Server neu vornehmen."),
      confirmLabel: t("Übertragen"),
      destructive: false,
    });
    if (!confirmed) return;
    setPhase("sending");
    try {
      await api.pushWorkspaceToServer(serverUrl, serverToken);
      setPhase("done");
    } catch (migrationError) {
      setPhase("idle");
      onError(migrationError);
    }
  };

  return (
    <div className="grid gap-2">
      <span className="text-sm">{t("Auf Server umziehen")}</span>
      <p className="text-xs text-muted-foreground">{t("Überträgt deinen lokalen Workspace mit einem Klick auf einen Harnold-Server.")}</p>
      <Input placeholder={t("Server-Adresse, z. B. https://harnold.meinserver.de")} value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
      <Input type="password" placeholder={t("Zugriffstoken des Servers")} value={serverToken} onChange={(event) => setServerToken(event.target.value)} />
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!serverUrl.trim() || phase === "sending"} onClick={() => void migrate()}>
          {phase === "sending" && <Loader2 className="size-3.5 animate-spin" />}
          {phase === "sending" ? t("Überträgt …") : t("Zum Server übertragen")}
        </Button>
        {phase === "done" && <span className="text-xs text-muted-foreground">{t("Übertragen. Der Server startet neu; danach oben unter „Workspace“ verbinden.")}</span>}
      </div>
    </div>
  );
}
