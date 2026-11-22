import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appVersion, checkForUpdate, installUpdate, updatesSupported, useAvailableUpdate, type AvailableUpdate } from "@/lib/app-updates";
import { t } from "@/lib/i18n";

type UpdateState = { phase: "idle" | "checking" | "current" | "installing" } | { phase: "available"; update: AvailableUpdate } | { phase: "error"; message: string };

/** Settings → General: installed version, check for updates on demand, install and restart. */
export function AppVersionSetting() {
  const backgroundUpdate = useAvailableUpdate();
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
          {updatesSupported() &&
            (shownState.phase === "available" ? (
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
      {shownState.phase === "available" && <p className="text-right text-[12px] text-muted-foreground">{t("Lädt das Update, installiert es und startet Harnold neu.")}</p>}
      {shownState.phase === "installing" && <p className="text-right text-[12px] text-muted-foreground">{t("Harnold startet gleich neu.")}</p>}
      {shownState.phase === "error" && <p className="text-right text-[12px] text-destructive">{shownState.message}</p>}
    </div>
  );
}
