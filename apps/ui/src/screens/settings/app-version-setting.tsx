import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appVersion, checkForUpdate, installUpdate, useAvailableUpdate, useCanInstallOnServer, useUpdateMode, type AvailableUpdate } from "@/lib/app-updates";
import { t } from "@/lib/i18n";

type UpdateState = { phase: "idle" | "checking" | "current" | "installing" } | { phase: "available"; update: AvailableUpdate } | { phase: "error"; message: string };

/** Settings → General: installed version, check for updates on demand, install and restart. */
export function AppVersionSetting() {
  const backgroundUpdate = useAvailableUpdate();
  const updateMode = useUpdateMode();
  const canInstallOnServer = useCanInstallOnServer();
  const installsItself = updateMode === "desktop" || (updateMode === "docker" && canInstallOnServer);
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: "idle" });
  const shownState: UpdateState = updateState.phase === "idle" && backgroundUpdate ? { phase: "available", update: backgroundUpdate } : updateState;

  const check = async () => {
    setUpdateState({ phase: "checking" });
    try {
      const update = await checkForUpdate();
      setUpdateState(update ? { phase: "available", update } : { phase: "current" });
    } catch (checkError) {
      setUpdateState({ phase: "error", message: String(checkError) });
    }
  };
  const install = async () => {
    setUpdateState({ phase: "installing" });
    try {
      await installUpdate();
    } catch (installError) {
      setUpdateState({ phase: "error", message: String(installError) });
    }
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm">{t("Version")}</span>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground tabular-nums">{appVersion}</span>
          {updateMode &&
            (shownState.phase === "available" && installsItself ? (
              <Button size="sm" onClick={() => void install()}>
                {t("Auf {0} aktualisieren", shownState.update.version)}
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={shownState.phase === "checking" || shownState.phase === "installing"} onClick={() => void check()}>
                {(shownState.phase === "checking" || shownState.phase === "installing") && <Loader2 className="size-3.5 animate-spin" />}
                {shownState.phase === "installing" ? t("Installiert …") : t("Nach Updates suchen")}
              </Button>
            ))}
        </div>
      </div>
      {shownState.phase === "current" && <p className="text-right text-[12px] text-muted-foreground">{t("Harnold ist aktuell.")}</p>}
      {shownState.phase === "available" && installsItself && <p className="text-right text-[12px] text-muted-foreground">{updateMode === "docker" ? t("Lädt das neue Image und startet den Server neu. Laufende Sitzungen werden unterbrochen.") : t("Lädt das Update, installiert es und startet Harnold neu.")}</p>}
      {shownState.phase === "available" && updateMode === "docker" && !canInstallOnServer && (
        <div className="grid gap-1 text-right text-[12px] text-muted-foreground">
          <span>{t("Version {0} ist verfügbar. Auf dem Server ausführen:", shownState.update.version)}</span>
          <code className="ml-auto rounded bg-muted px-2 py-1 font-mono text-[11px] text-foreground select-all">docker compose pull && docker compose up -d</code>
          <span>{t("Oder automatisch: docker compose --profile autoupdate up -d")}</span>
        </div>
      )}
      {shownState.phase === "installing" && <p className="text-right text-[12px] text-muted-foreground">{t("Harnold startet gleich neu.")}</p>}
      {shownState.phase === "error" && <p className="text-right text-[12px] text-destructive">{shownState.message}</p>}
    </div>
  );
}
