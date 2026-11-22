import { useEffect, useState } from "react";
import { api } from "@/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/lib/i18n";

const autoDeleteOptions: { days: number | null; label: string }[] = [
  { days: null, label: t("Nie") },
  { days: 1, label: t("Nach 1 Tag") },
  { days: 7, label: t("Nach 7 Tagen") },
  { days: 30, label: t("Nach 30 Tagen") },
  { days: 90, label: t("Nach 90 Tagen") },
];

/** Quick Chats (no project) are deleted once untouched for X days; saved on change. */
export function QuickChatAutoDeleteSetting(props: { onSaved: (message: string) => void; onError: (unknownError: unknown) => void }) {
  const [autoDeleteDays, setAutoDeleteDays] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    api.readQuickChatSettings().then((settings) => setAutoDeleteDays(settings.autoDeleteDays)).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (autoDeleteDays === undefined) return null;
  const choose = (value: string) => {
    const days = value === "never" ? null : Number(value);
    setAutoDeleteDays(days);
    api
      .saveQuickChatSettings({ autoDeleteDays: days })
      .then(() => props.onSaved(days ? (days === 1 ? t("Quick Chats werden nach 1 Tag gelöscht") : t("Quick Chats werden nach {0} Tagen gelöscht", days)) : t("Quick Chats bleiben erhalten")))
      .catch(props.onError);
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{t("Quick Chats automatisch löschen")}</span>
      <Select value={autoDeleteDays === null ? "never" : String(autoDeleteDays)} onValueChange={choose}>
        <SelectTrigger size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {autoDeleteOptions.map((option) => (
            <SelectItem key={option.label} value={option.days === null ? "never" : String(option.days)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
