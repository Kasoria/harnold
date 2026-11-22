import { useEffect, useState } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { DetailPane, EmptyState, ListRow, MasterDetail } from "./screen-layout";
import { api } from "@/api";
import type { PluginInfo, PluginSource } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/form-field";
import { confirmAction } from "@/components/confirm-dialog";
import { t } from "@/lib/i18n";

const sourceLabels: Record<PluginSource, string> = { "claude-code": t("Claude Code"), "claude-desktop": t("Claude Desktop"), folder: t("Ordner") };

type PluginsViewProps = {
  selectedItemId: string | null;
  onSelect: (itemId: string | null) => void;
  changeCounter: number;
  onError: (unknownError: unknown) => void;
};

/** Claude plugins (skills, commands, agents, hooks, MCP servers) from Claude Code, Claude Desktop or any folder. */
export function PluginsView(props: PluginsViewProps) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [folderPath, setFolderPath] = useState("");
  const [adding, setAdding] = useState(false);

  const reload = () => api.listPlugins().then(setPlugins).catch(props.onError);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.changeCounter]);

  const setEnabled = (plugin: PluginInfo, enabled: boolean) => {
    setPlugins((previous) => previous.map((candidate) => (candidate.id === plugin.id ? { ...candidate, enabled } : candidate)));
    api.setPluginEnabled(plugin.id, enabled).catch((toggleError) => {
      props.onError(toggleError);
      void reload();
    });
  };

  const addFolder = async () => {
    setAdding(true);
    try {
      const plugin = await api.addPluginFolder(folderPath.trim());
      setFolderPath("");
      await reload();
      props.onSelect(plugin.id);
    } catch (addError) {
      props.onError(addError);
    } finally {
      setAdding(false);
    }
  };

  const removeFolder = async (plugin: PluginInfo) => {
    if (!(await confirmAction({ title: t("Plugin „{0}“ entfernen?", plugin.name), description: t("Nur aus Harnold – der Ordner bleibt."), confirmLabel: t("Entfernen") }))) return;
    try {
      await api.removePluginFolder(plugin.id);
      props.onSelect(null);
      await reload();
    } catch (removeError) {
      props.onError(removeError);
    }
  };

  const selectedPlugin = plugins.find((plugin) => plugin.id === props.selectedItemId) ?? null;

  const detail =
    props.selectedItemId === "new" ? (
      <DetailPane detailKey="new" title={t("Plugin-Ordner hinzufügen")} subtitle={t("Ordner mit .claude-plugin/plugin.json, z. B. ein geklontes Plugin-Repo.")}>
        <form
          className="grid gap-4"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void addFolder();
          }}
        >
          <FormField label={t("Pfad")}>
            <Input autoFocus value={folderPath} placeholder="~/Code/mein-plugin" className="font-mono text-[12.5px]" onChange={(changeEvent) => setFolderPath(changeEvent.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={adding || !folderPath.trim()}>
              {t("Hinzufügen")}
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => props.onSelect(null)}>
              {t("Abbrechen")}
            </Button>
          </div>
        </form>
      </DetailPane>
    ) : selectedPlugin ? (
      <DetailPane
        detailKey={selectedPlugin.id}
        title={selectedPlugin.name}
        subtitle={[sourceLabels[selectedPlugin.source], selectedPlugin.version].filter(Boolean).join(" · ")}
        actions={
          <div className="flex items-center gap-3">
            {selectedPlugin.source === "folder" && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void removeFolder(selectedPlugin)}>
                <Trash2 className="size-3.5" /> {t("Entfernen")}
              </Button>
            )}
            <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              {t("Aktiv")}
              <Switch checked={selectedPlugin.enabled} onCheckedChange={(enabled) => setEnabled(selectedPlugin, enabled)} />
            </label>
          </div>
        }
      >
        <div className="grid gap-4 text-[13px]">
          {selectedPlugin.description && <p className="leading-relaxed">{selectedPlugin.description}</p>}
          <FormField label={t("Ordner")}>
            <div className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 font-mono text-[12px] break-all text-muted-foreground">
              <FolderOpen className="size-3.5 shrink-0" />
              {selectedPlugin.path}
            </div>
          </FormField>
          {selectedPlugin.source === "claude-code" && (
            <p className="text-[12px] text-muted-foreground">{t("Schalter gilt nur für Harnold, Claude Code bleibt unverändert.")}</p>
          )}
        </div>
      </DetailPane>
    ) : (
      <EmptyState
        title={plugins.length ? t("Plugin wählen") : t("Keine Plugins gefunden")}
        description={t("Aus Claude Code, Claude Desktop oder einem eigenen Ordner. Gilt ab dem nächsten Durchlauf.")}
        action={
          <Button size="sm" onClick={() => props.onSelect("new")}>
            <Plus className="size-3.5" /> {t("Ordner hinzufügen")}
          </Button>
        }
      />
    );

  return (
    <MasterDetail
      list={
        plugins.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{t("Keine Plugins.")}</p>
        ) : (
          plugins.map((plugin) => (
            <ListRow
              key={plugin.id}
              selected={plugin.id === props.selectedItemId}
              onSelect={() => props.onSelect(plugin.id)}
              leading={<Switch checked={plugin.enabled} onCheckedChange={(enabled) => setEnabled(plugin, enabled)} aria-label={t("Aktiv")} />}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium">{plugin.name}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">{sourceLabels[plugin.source]}</span>
              </div>
              <div className="line-clamp-2 text-[11.5px] text-muted-foreground">{plugin.description || t("Keine Beschreibung")}</div>
            </ListRow>
          ))
        )
      }
      detail={detail}
    />
  );
}
