import { appVersion, useAvailableUpdate } from "@/lib/app-updates";
import { t } from "@/lib/i18n";

/** Installed version in the bottom right of the middle pane; a newer one shows as "Update" and leads to the settings. */
export function AppVersionBadge(props: { onOpenSettings: () => void }) {
  const availableUpdate = useAvailableUpdate();
  if (availableUpdate) {
    return (
      <button
        className="absolute right-3 bottom-1.5 z-20 flex items-center gap-1 text-[11px] font-medium text-primary transition-opacity hover:opacity-80"
        title={t("Update auf {0} verfügbar", availableUpdate.version)}
        onClick={props.onOpenSettings}
      >
        <span className="size-1.5 rounded-full bg-primary" />
        {t("Update auf {0}", availableUpdate.version)}
      </button>
    );
  }
  return <span className="pointer-events-none absolute right-3 bottom-1.5 z-20 text-[11px] text-muted-foreground/50 tabular-nums select-none">v{appVersion}</span>;
}
