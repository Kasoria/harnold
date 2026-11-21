import { useEffect, useState } from "react";
import { api } from "@/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const autoDeleteOptions: { days: number | null; label: string }[] = [
  { days: null, label: "Nie" },
  { days: 1, label: "Nach 1 Tag" },
  { days: 7, label: "Nach 7 Tagen" },
  { days: 30, label: "Nach 30 Tagen" },
  { days: 90, label: "Nach 90 Tagen" },
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
      .then(() => props.onSaved(days ? `Quick Chats werden nach ${days} ${days === 1 ? "Tag" : "Tagen"} gelöscht` : "Quick Chats bleiben erhalten"))
      .catch(props.onError);
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">Quick Chats automatisch löschen</span>
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
