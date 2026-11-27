import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/api";
import type { LimitsView, LimitWindow, ProviderLimits } from "@/types";
import { cn } from "@/lib/utils";
import { locale, t } from "@/lib/i18n";

const refreshIntervalMs = 90_000;

type LimitScope = { projectId?: string | null; environmentId?: string | null };

/** Loads the subscription limits and keeps them fresh while `active` (e.g. a popover is open or the sidebar is shown). */
export function useProviderLimits(scope: LimitScope, active = true) {
  const [view, setView] = useState<LimitsView | null>(null);
  const [loading, setLoading] = useState(false);
  const { projectId, environmentId } = scope;

  const reload = useCallback(() => {
    setLoading(true);
    api
      .readLimits({ projectId, environmentId })
      .then(setView)
      .catch(() => setView((previous) => previous))
      .finally(() => setLoading(false));
  }, [projectId, environmentId]);

  useEffect(() => {
    if (!active) return;
    reload();
    const interval = setInterval(reload, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [active, reload]);

  return { view, loading, reload };
}

/** "Wird um 14:40 zurückgesetzt" / "Zurücksetzung am Montag, 22:00" */
function resetText(resetsAt: number | null): string | null {
  if (resetsAt === null) return null;
  const resetDate = new Date(resetsAt);
  const time = resetDate.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  if (resetDate.toDateString() === new Date().toDateString()) return t("Wird um {0} zurückgesetzt", time);
  const weekday = resetDate.toLocaleDateString(locale(), { weekday: "long" });
  return t("Zurücksetzung am {0}, {1}", weekday, time);
}

const barColor = (usedPercent: number) => (usedPercent >= 90 ? "bg-destructive" : usedPercent >= 75 ? "bg-status-waiting" : "bg-primary");

function LimitBar(props: { window: LimitWindow; compact?: boolean }) {
  const percent = Math.round(props.window.usedPercent);
  const reset = resetText(props.window.resetsAt);
  return (
    <div className={props.compact ? "grid gap-1" : "grid gap-1.5"}>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className={props.compact ? "text-muted-foreground" : "text-foreground"}>{t(props.window.label)}</span>
        <span className="tabular-nums text-muted-foreground">{t("{0} % verwendet", percent)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full transition-[width] duration-500", barColor(props.window.usedPercent))} style={{ width: `${Math.max(2, percent)}%` }} />
      </div>
      {reset && <span className="text-[11.5px] text-muted-foreground">{reset}</span>}
    </div>
  );
}

function ProviderBlock(props: { provider: ProviderLimits; compact?: boolean; showTitle: boolean }) {
  const { provider } = props;
  return (
    <div className="grid gap-2.5">
      {props.showTitle && (
        <div className="flex items-baseline gap-1.5 text-[12px] font-medium">
          {provider.label}
          {provider.plan && <span className="text-[11px] font-normal text-muted-foreground capitalize">{provider.plan}</span>}
        </div>
      )}
      {provider.windows.map((limitWindow) => (
        <LimitBar key={limitWindow.id} window={limitWindow} compact={props.compact} />
      ))}
      {provider.error && <span className="text-[11.5px] text-muted-foreground">{provider.error}</span>}
    </div>
  );
}

/** Bars of all connected providers (or only `only`). Renders nothing without a subscription login. */
export function ProviderLimitsList(props: { view: LimitsView | null; loading?: boolean; compact?: boolean; only?: string }) {
  const providers = (props.view?.providers ?? []).filter((provider) => !props.only || provider.id === props.only);
  if (!props.view) return props.loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null;
  if (providers.length === 0) return <p className="text-[12px] text-muted-foreground">{t("Keine Abo-Limits – nur mit Claude- oder ChatGPT-Anmeldung.")}</p>;
  return (
    <div className="grid gap-4">
      {providers.map((provider) => (
        <ProviderBlock key={provider.id} provider={provider} compact={props.compact} showTitle={providers.length > 1 || Boolean(provider.plan)} />
      ))}
    </div>
  );
}

export function RefreshLimitsButton(props: { loading: boolean; onClick: () => void }) {
  return (
    <button type="button" className="text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={props.onClick} disabled={props.loading} aria-label={t("Neu laden")}>
      {props.loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
    </button>
  );
}

/** Highest usage across all windows – for compact badges. */
export const highestUsedPercent = (view: LimitsView | null): number | null => {
  const percents = (view?.providers ?? []).flatMap((provider) => provider.windows.map((limitWindow) => limitWindow.usedPercent));
  return percents.length ? Math.max(...percents) : null;
};

/** Settings section: the same bars as in the chat popover. */
export function LimitsSection(props: { environmentId?: string | null }) {
  const { view, loading, reload } = useProviderLimits({ environmentId: props.environmentId });
  return (
    <section className="grid gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium">{t("Nutzungslimits")}</h3>
        <RefreshLimitsButton loading={loading} onClick={reload} />
      </div>
      <ProviderLimitsList view={view} loading={loading} />
    </section>
  );
}
