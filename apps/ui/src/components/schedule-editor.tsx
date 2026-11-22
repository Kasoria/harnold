import { useEffect, useMemo, useState } from "react";
import { Cron } from "croner";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import { locale, t } from "@/lib/i18n";

/**
 * Click-based schedule editor that writes a cron expression (what the Core runs).
 * Anything the builder can't express stays editable as "Cron".
 */
type ScheduleConfig =
  | { kind: "daily"; time: string; weekdays: number[] }
  | { kind: "interval"; everyHours: number; minute: number; fromHour: number; toHour: number; weekdays: number[] }
  | { kind: "monthly"; dayOfMonth: number | "last"; time: string }
  | { kind: "custom"; expression: string };

const allWeekdays = [1, 2, 3, 4, 5, 6, 0]; // Monday first; cron counts Sunday as 0
const workdays = [1, 2, 3, 4, 5];
const intervalHourOptions = [1, 2, 3, 4, 6, 8, 12];
const minuteOptions = [0, 15, 30, 45];

const weekdayShortName = (weekday: number) => new Date(2024, 0, 7 + weekday).toLocaleDateString(locale(), { weekday: "short" }).replace(".", "");
const weekdayLongName = (weekday: number) => new Date(2024, 0, 7 + weekday).toLocaleDateString(locale(), { weekday: "long" });
const twoDigits = (value: number) => String(value).padStart(2, "0");

// ---------------------------------------------------------------- cron <-> config

function parseWeekdays(field: string): number[] | null {
  if (field === "*") return [...allWeekdays];
  const weekdays = new Set<number>();
  for (const part of field.split(",")) {
    const rangeMatch = /^(\d)(?:-(\d))?$/.exec(part);
    if (!rangeMatch) return null;
    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] === undefined ? start : Number(rangeMatch[2]);
    if (start > 7 || end > 7 || end < start) return null;
    for (let weekday = start; weekday <= end; weekday++) weekdays.add(weekday % 7);
  }
  return allWeekdays.filter((weekday) => weekdays.has(weekday));
}

function weekdaysField(weekdays: number[]): string {
  if (weekdays.length === 0 || weekdays.length === 7) return "*";
  const sorted = [...new Set(weekdays)].sort((first, second) => first - second);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length; index++) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    ranges.push(end - index >= 2 ? `${sorted[index]}-${sorted[end]}` : sorted.slice(index, end + 1).join(","));
    index = end;
  }
  return ranges.join(",");
}

function parseTime(minuteField: string, hourField: string): string | null {
  if (!/^\d+$/.test(minuteField) || !/^\d+$/.test(hourField)) return null;
  const minute = Number(minuteField);
  const hour = Number(hourField);
  return minute < 60 && hour < 24 ? `${twoDigits(hour)}:${twoDigits(minute)}` : null;
}

export function parseSchedule(expression: string): ScheduleConfig {
  const fields = expression.trim().split(/\s+/);
  const custom: ScheduleConfig = { kind: "custom", expression };
  if (fields.length !== 5) return custom;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  if (monthField !== "*") return custom;

  if (dayField !== "*") {
    const time = parseTime(minuteField, hourField);
    if (weekdayField !== "*" || !time) return custom;
    if (dayField === "L") return { kind: "monthly", dayOfMonth: "last", time };
    return /^\d+$/.test(dayField) && Number(dayField) >= 1 && Number(dayField) <= 31 ? { kind: "monthly", dayOfMonth: Number(dayField), time } : custom;
  }

  const weekdays = parseWeekdays(weekdayField);
  if (!weekdays) return custom;
  const time = parseTime(minuteField, hourField);
  if (time) return { kind: "daily", time, weekdays };

  // Interval: hour field "*", "*/n", "a-b" or "a-b/n"
  const intervalMatch = /^(\*|(\d+)-(\d+))(?:\/(\d+))?$/.exec(hourField);
  if (!intervalMatch || !/^\d+$/.test(minuteField)) return custom;
  const everyHours = Number(intervalMatch[4] ?? 1);
  if (!intervalHourOptions.includes(everyHours)) return custom;
  return {
    kind: "interval",
    everyHours,
    minute: Number(minuteField),
    fromHour: intervalMatch[2] === undefined ? 0 : Number(intervalMatch[2]),
    toHour: intervalMatch[3] === undefined ? 23 : Number(intervalMatch[3]),
    weekdays,
  };
}

export function buildSchedule(config: ScheduleConfig): string {
  if (config.kind === "custom") return config.expression.trim();
  if (config.kind === "monthly") {
    const [hour, minute] = config.time.split(":").map(Number);
    return `${minute} ${hour} ${config.dayOfMonth === "last" ? "L" : config.dayOfMonth} * *`;
  }
  if (config.kind === "daily") {
    const [hour, minute] = config.time.split(":").map(Number);
    return `${minute} ${hour} * * ${weekdaysField(config.weekdays)}`;
  }
  const wholeDay = config.fromHour === 0 && config.toHour === 23;
  const hourRange = wholeDay ? "*" : `${config.fromHour}-${config.toHour}`;
  return `${config.minute} ${hourRange}${config.everyHours > 1 ? `/${config.everyHours}` : ""} * * ${weekdaysField(config.weekdays)}`;
}

function describeWeekdays(weekdays: number[]): string {
  const field = weekdaysField(weekdays);
  if (field === "*") return t("Täglich");
  if (field === "1-5") return t("Werktags");
  if (field === "0,6") return t("Am Wochenende");
  if (weekdays.length === 1) return t("{0}s", weekdayLongName(weekdays[0]));
  return weekdays.map(weekdayShortName).join(", ");
}

/** Short readable form for lists, e.g. "Werktags 08:00" or "Alle 2 Std. · 08–18 Uhr". */
export function describeSchedule(expression: string): string {
  const config = parseSchedule(expression);
  if (config.kind === "custom") return expression;
  if (config.kind === "daily") return `${describeWeekdays(config.weekdays)} ${config.time}`;
  if (config.kind === "monthly") return config.dayOfMonth === "last" ? t("Monatlich am letzten Tag, {0}", config.time) : t("Monatlich am {0}., {1}", config.dayOfMonth, config.time);
  const window = config.fromHour === 0 && config.toHour === 23 ? "" : ` · ${twoDigits(config.fromHour)}–${twoDigits(config.toHour)} ${t("Uhr")}`;
  const rhythm = config.everyHours === 1 ? t("Stündlich") : t("Alle {0} Std.", config.everyHours);
  const days = weekdaysField(config.weekdays) === "*" ? "" : ` · ${describeWeekdays(config.weekdays)}`;
  return `${rhythm}${config.minute ? ` (:${twoDigits(config.minute)})` : ""}${window}${days}`;
}

function nextRunsOf(expression: string, count: number): Date[] | null {
  try {
    const job = new Cron(expression, { paused: true });
    const runs = job.nextRuns(count);
    job.stop();
    return runs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- UI

function SegmentedControl<Value extends string>(props: { value: Value; options: { value: Value; label: string }[]; onChange: (value: Value) => void }) {
  return (
    <div className="inline-flex rounded-lg bg-foreground/[0.05] p-0.5">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(
            "rounded-md px-3 py-1 text-[13px] transition-colors",
            props.value === option.value ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function WeekdayPicker(props: { weekdays: number[]; onChange: (weekdays: number[]) => void }) {
  const toggle = (weekday: number) => {
    const next = props.weekdays.includes(weekday) ? props.weekdays.filter((entry) => entry !== weekday) : [...props.weekdays, weekday];
    if (next.length) props.onChange(allWeekdays.filter((entry) => next.includes(entry)));
  };
  const field = weekdaysField(props.weekdays);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {allWeekdays.map((weekday) => (
        <button
          key={weekday}
          type="button"
          aria-pressed={props.weekdays.includes(weekday)}
          className={cn(
            "h-8 min-w-10 rounded-md border px-2 text-[13px] transition-colors",
            props.weekdays.includes(weekday) ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-foreground/[0.04]",
          )}
          onClick={() => toggle(weekday)}
        >
          {weekdayShortName(weekday)}
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-border" />
      <button type="button" className={cn("text-[12px] hover:text-foreground", field === "1-5" ? "font-medium text-foreground" : "text-muted-foreground")} onClick={() => props.onChange(workdays)}>
        {t("Werktags")}
      </button>
      <button type="button" className={cn("text-[12px] hover:text-foreground", field === "*" ? "font-medium text-foreground" : "text-muted-foreground")} onClick={() => props.onChange([...allWeekdays])}>
        {t("Jeden Tag")}
      </button>
    </div>
  );
}

function HourSelect(props: { value: number; onChange: (hour: number) => void; label: string }) {
  return (
    <Select value={String(props.value)} onValueChange={(value) => props.onChange(Number(value))}>
      <SelectTrigger size="sm" className="w-20" aria-label={props.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 24 }, (_, hour) => (
          <SelectItem key={hour} value={String(hour)}>
            {twoDigits(hour)}:00
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const rowClassName = "flex flex-wrap items-center gap-2 text-[13px]";
const rowLabelClassName = "w-24 shrink-0 text-muted-foreground";

export function ScheduleEditor(props: { value: string; onChange: (expression: string) => void }) {
  const [config, setConfig] = useState<ScheduleConfig>(() => parseSchedule(props.value));
  useEffect(() => {
    if (buildSchedule(config) !== props.value) props.onChange(buildSchedule(config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const switchKind = (kind: ScheduleConfig["kind"]) => {
    if (kind === config.kind) return;
    const time = "time" in config ? config.time : "08:00";
    const weekdays = "weekdays" in config ? config.weekdays : workdays;
    if (kind === "daily") setConfig({ kind, time, weekdays });
    else if (kind === "interval") setConfig({ kind, everyHours: 2, minute: 0, fromHour: 8, toHour: 18, weekdays });
    else if (kind === "monthly") setConfig({ kind, dayOfMonth: 1, time });
    else setConfig({ kind, expression: buildSchedule(config) });
  };

  const expression = buildSchedule(config);
  const nextRuns = useMemo(() => nextRunsOf(expression, 3), [expression]);

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <SegmentedControl
        value={config.kind}
        onChange={switchKind}
        options={[
          { value: "daily", label: t("Täglich") },
          { value: "interval", label: t("Mehrmals am Tag") },
          { value: "monthly", label: t("Monatlich") },
          { value: "custom", label: t("Cron") },
        ]}
      />

      {config.kind === "daily" && (
        <>
          <div className={rowClassName}>
            <span className={rowLabelClassName}>{t("Um")}</span>
            <Input type="time" className="h-8 w-28" value={config.time} onChange={(changeEvent) => changeEvent.target.value && setConfig({ ...config, time: changeEvent.target.value })} />
          </div>
          <div className={rowClassName}>
            <span className={rowLabelClassName}>{t("An")}</span>
            <WeekdayPicker weekdays={config.weekdays} onChange={(weekdays) => setConfig({ ...config, weekdays })} />
          </div>
        </>
      )}

      {config.kind === "interval" && (
        <>
          <div className={rowClassName}>
            <span className={rowLabelClassName}>{t("Alle")}</span>
            <Select value={String(config.everyHours)} onValueChange={(value) => setConfig({ ...config, everyHours: Number(value) })}>
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {intervalHourOptions.map((hours) => (
                  <SelectItem key={hours} value={String(hours)}>
                    {hours === 1 ? t("1 Stunde") : t("{0} Stunden", hours)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">{t("zur Minute")}</span>
            <Select value={String(config.minute)} onValueChange={(value) => setConfig({ ...config, minute: Number(value) })}>
              <SelectTrigger size="sm" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {minuteOptions.map((minute) => (
                  <SelectItem key={minute} value={String(minute)}>
                    :{twoDigits(minute)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className={rowClassName}>
            <span className={rowLabelClassName}>{t("Zwischen")}</span>
            <HourSelect label={t("Von")} value={config.fromHour} onChange={(fromHour) => setConfig({ ...config, fromHour, toHour: Math.max(fromHour, config.toHour) })} />
            <span className="text-muted-foreground">{t("und")}</span>
            <HourSelect label={t("Bis")} value={config.toHour} onChange={(toHour) => setConfig({ ...config, toHour, fromHour: Math.min(toHour, config.fromHour) })} />
            <button
              type="button"
              className="text-[12px] text-muted-foreground hover:text-foreground"
              onClick={() => setConfig({ ...config, fromHour: 0, toHour: 23 })}
            >
              {t("Ganzer Tag")}
            </button>
          </div>
          <div className={rowClassName}>
            <span className={rowLabelClassName}>{t("An")}</span>
            <WeekdayPicker weekdays={config.weekdays} onChange={(weekdays) => setConfig({ ...config, weekdays })} />
          </div>
        </>
      )}

      {config.kind === "monthly" && (
        <>
          <div className={rowClassName}>
            <span className={rowLabelClassName}>{t("Am")}</span>
            <Combobox
              size="sm"
              className="w-40"
              value={String(config.dayOfMonth)}
              options={[
                ...Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: t("{0}. des Monats", index + 1) })),
                { value: "last", label: t("Letzter Tag") },
              ]}
              onValueChange={(value) => setConfig({ ...config, dayOfMonth: value === "last" ? "last" : Number(value) })}
            />
          </div>
          <div className={rowClassName}>
            <span className={rowLabelClassName}>{t("Um")}</span>
            <Input type="time" className="h-8 w-28" value={config.time} onChange={(changeEvent) => changeEvent.target.value && setConfig({ ...config, time: changeEvent.target.value })} />
          </div>
          {typeof config.dayOfMonth === "number" && config.dayOfMonth > 28 && (
            <p className="text-[12px] text-muted-foreground">{t("Monate ohne diesen Tag werden übersprungen.")}</p>
          )}
        </>
      )}

      {config.kind === "custom" && (
        <div className="grid gap-1">
          <Input className="h-8 font-mono text-[13px]" value={config.expression} onChange={(changeEvent) => setConfig({ kind: "custom", expression: changeEvent.target.value })} />
          <span className="text-[12px] text-muted-foreground">{t("Minute Stunde Tag Monat Wochentag")}</span>
        </div>
      )}

      <div className="border-t pt-2.5 text-[12px] text-muted-foreground">
        {nextRuns === null ? (
          <span className="text-destructive">{t("Ungültiger Zeitplan")}</span>
        ) : nextRuns.length === 0 ? (
          t("Läuft nie")
        ) : (
          <>
            {t("Nächste Läufe:")}{" "}
            {nextRuns.map((runDate) => runDate.toLocaleString(locale(), { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })).join(" · ")}
          </>
        )}
      </div>
    </div>
  );
}
