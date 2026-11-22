import { useEffect, useState } from "react";
import { Check, Loader2, Plug, Plus, Trash2, X } from "lucide-react";
import { DetailPane, EmptyState, ListRow, MasterDetail, ScreenLayout } from "./screen-layout";
import { api } from "@/api";
import type { ExternalMcpServer, McpServer, McpServerInput, McpTransport, Project, Skill, SkillScope } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedControl } from "@/components/segmented-control";
import { StatusDot } from "@/components/status-dot";
import { FormField } from "@/components/form-field";
import { confirmAction } from "@/components/confirm-dialog";
import { PluginsView } from "./plugins-view";
import { t } from "@/lib/i18n";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";
import { toast } from "@/lib/toast";


type KeyValueRow = { key: string; value: string; stored: boolean };

/** Splits a command line like `npx -y "@scope/pkg" --flag` into arguments (quotes respected). */
export function splitCommandLine(commandLine: string): string[] {
  const commandArguments: string[] = [];
  let currentArgument = "";
  let activeQuote: string | null = null;
  let hasArgument = false;
  for (const character of commandLine) {
    if (activeQuote) {
      if (character === activeQuote) activeQuote = null;
      else currentArgument += character;
    } else if (character === '"' || character === "'") {
      activeQuote = character;
      hasArgument = true;
    } else if (/\s/.test(character)) {
      if (hasArgument || currentArgument) commandArguments.push(currentArgument);
      currentArgument = "";
      hasArgument = false;
    } else {
      currentArgument += character;
    }
  }
  if (hasArgument || currentArgument) commandArguments.push(currentArgument);
  return commandArguments;
}

const joinCommandLine = (commandArguments: string[]) => commandArguments.map((argument) => (/[\s"']/.test(argument) || !argument ? JSON.stringify(argument) : argument)).join(" ");

/** Parses Claude/Cursor style `{ "mcpServers": { name: {...} } }` (or the inner object) into inputs. */
function parseMcpJson(jsonText: string, scope: McpServerInput["scope"], projectId: string | null): McpServerInput[] {
  const parsedJson = JSON.parse(jsonText) as Record<string, unknown>;
  const serverEntries = (parsedJson.mcpServers ?? parsedJson) as Record<string, Record<string, unknown>>;
  return Object.entries(serverEntries).map(([serverName, serverConfig]) => {
    const transport: McpTransport = serverConfig.url ? (serverConfig.type === "sse" ? "sse" : "http") : "stdio";
    return {
      name: serverName.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40),
      scope,
      projectId: scope === "project" ? projectId : null,
      transport,
      command: String(serverConfig.command ?? ""),
      args: Array.isArray(serverConfig.args) ? serverConfig.args.map(String) : [],
      url: String(serverConfig.url ?? ""),
      env: (serverConfig.env as Record<string, string>) ?? {},
      headers: (serverConfig.headers as Record<string, string>) ?? {},
      autoAllow: false,
      enabled: true,
    };
  });
}

function KeyValueEditor(props: { label: string; hint?: string; rows: KeyValueRow[]; keyPlaceholder: string; onChange: (rows: KeyValueRow[]) => void }) {
  const updateRow = (rowIndex: number, changes: Partial<KeyValueRow>) =>
    props.onChange(props.rows.map((row, index) => (index === rowIndex ? { ...row, ...changes } : row)));
  return (
    <FormField label={props.label} hint={props.hint}>
      <div className="grid gap-1.5">
        {props.rows.map((row, rowIndex) => (
          <div key={rowIndex} className="flex animate-in gap-1.5 fade-in duration-150">
            <Input className="w-2/5 font-mono text-[12.5px]" placeholder={props.keyPlaceholder} value={row.key} onChange={(changeEvent) => updateRow(rowIndex, { key: changeEvent.target.value })} />
            <Input
              type="password"
              className="flex-1 font-mono text-[12.5px]"
              placeholder={row.stored ? "gespeichert" : t("Wert")}
              value={row.value}
              onChange={(changeEvent) => updateRow(rowIndex, { value: changeEvent.target.value })}
            />
            <Button variant="ghost" size="icon" className="size-9 shrink-0 text-muted-foreground" onClick={() => props.onChange(props.rows.filter((_, index) => index !== rowIndex))} aria-label={t("Entfernen")}>
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="sm" className="h-7 justify-self-start gap-1.5 px-2 text-[12px] text-muted-foreground" onClick={() => props.onChange([...props.rows, { key: "", value: "", stored: false }])}>
          <Plus className="size-3.5" /> {t("Hinzufügen")}
        </Button>
      </div>
    </FormField>
  );
}

const toRecord = (rows: KeyValueRow[]) => Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));

function McpServerEditor(props: {
  server: McpServer | null;
  project: Project | null;
  /** Saved server id; null on cancel/removal. */
  onDone: (savedServerId: string | null) => void;
  onError: (unknownError: unknown) => void;
}) {
  const existingServer = props.server;
  const [serverInput, setServerInput] = useState<McpServerInput>(() =>
    existingServer
      ? { ...existingServer, env: {}, headers: {} }
      : { name: "", scope: props.project ? "project" : "workspace", projectId: props.project?.id ?? null, transport: "stdio", command: "", args: [], url: "", env: {}, headers: {}, autoAllow: false, enabled: true },
  );
  const [commandLine, setCommandLine] = useState(existingServer ? joinCommandLine([existingServer.command, ...existingServer.args].filter(Boolean)) : "");
  const [envRows, setEnvRows] = useState<KeyValueRow[]>((existingServer?.envKeys ?? []).map((key) => ({ key, value: "", stored: true })));
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>((existingServer?.headerKeys ?? []).map((key) => ({ key, value: "", stored: true })));
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [saving, setSaving] = useState(false);
  const { saved, flashSaved } = useSavedFlash();

  const updateInput = (changes: Partial<McpServerInput>) => setServerInput((previous) => ({ ...previous, ...changes }));

  const save = async () => {
    setSaving(true);
    try {
      let savedServerId: string | null = null;
      if (jsonMode) {
        for (const importedInput of parseMcpJson(jsonText, serverInput.scope, serverInput.projectId)) savedServerId = (await api.createMcpServer(importedInput)).id;
      } else {
        const [command = "", ...commandArguments] = splitCommandLine(commandLine);
        const completeInput: McpServerInput = { ...serverInput, command, args: commandArguments, env: toRecord(envRows), headers: toRecord(headerRows) };
        savedServerId = (existingServer ? await api.updateMcpServer(existingServer.id, completeInput) : await api.createMcpServer(completeInput)).id;
      }
      flashSaved();
      if (!existingServer) toast.success(jsonMode ? t("MCP-Server importiert") : t("MCP-Server hinzugefügt"));
      props.onDone(savedServerId);
    } catch (saveError) {
      props.onError(saveError instanceof SyntaxError ? new Error(t("Ungültiges JSON")) : saveError);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existingServer || !(await confirmAction({ title: t("MCP-Server „{0}“ entfernen?", existingServer.name), confirmLabel: t("Entfernen") }))) return;
    await api
      .deleteMcpServer(existingServer.id)
      .then(() => {
        toast.success(t("MCP-Server „{0}“ entfernt", existingServer.name));
        props.onDone(null);
      })
      .catch(props.onError);
  };

  return (
    <div className="grid gap-4">
      {!existingServer && (
        <SegmentedControl
          options={[
            { value: "form", label: t("Formular") },
            { value: "json", label: t("JSON einfügen") },
          ]}
          value={jsonMode ? "json" : "form"}
          onValueChange={(value) => setJsonMode(value === "json")}
        />
      )}

      <FormField label={t("Gültig für")}>
        <Select value={serverInput.scope} onValueChange={(value) => updateInput({ scope: value as McpServerInput["scope"], projectId: value === "project" ? (props.project?.id ?? null) : null })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {props.project && <SelectItem value="project">{t("Projekt „")}{props.project.name}“</SelectItem>}
            <SelectItem value="workspace">{t("Alle Projekte")}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {jsonMode ? (
        <FormField label={t("Konfiguration")} hint={t("JSON wie in Claude Desktop (mcpServers).")}>
          <Textarea
            className="min-h-40 animate-in font-mono text-[12.5px] fade-in duration-200"
            placeholder={t("{\n  \"mcpServers\": {\n    \"github\": { \"command\": \"npx\", \"args\": [\"-y\", \"@modelcontextprotocol/server-github\"] }\n  }\n}")}
            value={jsonText}
            onChange={(changeEvent) => setJsonText(changeEvent.target.value)}
          />
        </FormField>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <FormField label={t("Name")}>
              <Input value={serverInput.name} placeholder="github" onChange={(changeEvent) => updateInput({ name: changeEvent.target.value })} />
            </FormField>
            <FormField label={t("Verbindung")}>
              <SegmentedControl
                className="w-52"
                options={[
                  { value: "stdio", label: t("Lokal") },
                  { value: "http", label: "HTTP" },
                  { value: "sse", label: "SSE" },
                ]}
                value={serverInput.transport}
                onValueChange={(transport) => updateInput({ transport })}
              />
            </FormField>
          </div>

          {serverInput.transport === "stdio" ? (
            <>
              <FormField label={t("Befehl")}>
                <Input className="font-mono text-[12.5px]" value={commandLine} placeholder={t("npx -y @modelcontextprotocol/server-github")} onChange={(changeEvent) => setCommandLine(changeEvent.target.value)} />
              </FormField>
              <KeyValueEditor label={t("Umgebungsvariablen")} rows={envRows} keyPlaceholder="GITHUB_TOKEN" onChange={setEnvRows} />
            </>
          ) : (
            <>
              <FormField label="URL">
                <Input className="font-mono text-[12.5px]" value={serverInput.url} placeholder="https://example.com/mcp" onChange={(changeEvent) => updateInput({ url: changeEvent.target.value })} />
              </FormField>
              <KeyValueEditor label={t("Header")} rows={headerRows} keyPlaceholder="Authorization" onChange={setHeaderRows} />
            </>
          )}

          <label className="flex items-center justify-between gap-4 text-[13px]">
            <span>
              {t("Tools ohne Nachfrage erlauben")}
              <span className="block text-[11.5px] text-muted-foreground">{t("Sonst gilt der Permission-Modus der Session.")}</span>
            </span>
            <Switch checked={serverInput.autoAllow} onCheckedChange={(autoAllow) => updateInput({ autoAllow })} />
          </label>
        </>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {existingServer ? t("Speichern") : jsonMode ? t("Importieren") : t("Hinzufügen")}
          <SavedCheck saved={saved} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => props.onDone(null)}>
          {t("Abbrechen")}
        </Button>
        {existingServer && (
          <Button size="sm" variant="ghost" className="ml-auto gap-1.5 text-muted-foreground hover:text-destructive" onClick={() => void remove()}>
            <Trash2 className="size-3.5" /> {t("Entfernen")}
          </Button>
        )}
      </div>
    </div>
  );
}

export type IntegrationsTab = "mcp" | "skills" | "plugins";

type IntegrationsScreenProps = {
  project: Project | null;
  activeTab: IntegrationsTab;
  /** MCP server id, skill key (`scope:path`) or "new". */
  selectedItemId: string | null;
  onNavigate: (tab: IntegrationsTab, itemId: string | null) => void;
  integrationsChangeCounter: number;
  onError: (unknownError: unknown) => void;
};

const skillKeyOf = (skill: Skill) => `${skill.scope}:${skill.path}`;

function McpServerDetail(props: { server: McpServer; project: Project | null; onDone: (savedServerId: string | null) => void; onError: (unknownError: unknown) => void }) {
  const [testing, setTesting] = useState(false);
  const server = props.server;

  const runTest = async () => {
    setTesting(true);
    await api.testMcpServer(server.id).catch(props.onError);
    setTesting(false);
  };

  return (
    <DetailPane
      detailKey={server.id}
      title={server.name}
      subtitle={
        <span className="font-mono text-[11.5px]">{server.transport === "stdio" ? joinCommandLine([server.command, ...server.args]) : server.url}</span>
      }
      actions={
        <Button size="sm" variant="secondary" disabled={testing} onClick={() => void runTest()}>
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />} {t("Testen")}
        </Button>
      }
    >
      {server.lastTest && (
        <div className="mb-5 animate-in rounded-xl border p-3 fade-in duration-200">
          <div className="flex items-center gap-2 text-[12.5px]">
            <StatusDot status={server.lastTest.ok ? "running" : "error"} />
            {server.lastTest.ok ? t("{0} Tools verfügbar", server.lastTest.tools.length) : t("Verbindung fehlgeschlagen")}
          </div>
          {server.lastTest.error && <p className="mt-1.5 text-[12px] text-destructive">{server.lastTest.error}</p>}
          {server.lastTest.tools.length > 0 && (
            <ul className="mt-2 grid gap-1">
              {server.lastTest.tools.map((serverTool) => (
                <li key={serverTool.name} className="flex gap-2 text-[12px]">
                  <span className="shrink-0 font-mono">{serverTool.name}</span>
                  <span className="truncate text-muted-foreground">{serverTool.description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <McpServerEditor key={server.id} server={server} project={props.project} onDone={props.onDone} onError={props.onError} />
    </DetailPane>
  );
}

/** MCP servers from other AI tools on this machine: shown, and taken over into Harnold with one click. */
function ExternalMcpServers(props: { project: Project | null; changeCounter: number; onImported: () => void; onError: (unknownError: unknown) => void }) {
  const [externalServers, setExternalServers] = useState<ExternalMcpServer[]>([]);
  const [importingKey, setImportingKey] = useState<string | null>(null);

  useEffect(() => {
    api.listExternalMcpServers(props.project?.id ?? null).then(setExternalServers).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.changeCounter, props.project?.id]);

  if (externalServers.length === 0) return null;

  const importServer = async (server: ExternalMcpServer) => {
    const serverKey = `${server.sourceId}:${server.name}`;
    setImportingKey(serverKey);
    try {
      await api.importMcpServer(server.sourceId, server.name, props.project?.id ?? null);
      props.onImported();
    } catch (importError) {
      props.onError(importError);
    } finally {
      setImportingKey(null);
    }
  };

  return (
    <div className="mt-4 grid gap-0.5">
      <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("Mitgebracht")}</div>
      {externalServers.map((server) => (
        <div key={`${server.sourceId}:${server.name}`} className="flex items-center gap-2 rounded-md px-2 py-1.5" title={server.target}>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px]">{server.name}</div>
            <div className="truncate text-[11.5px] text-muted-foreground">
              {server.sourceLabel}
              {server.activeViaClaude && t(" · aktiv über Claude")}
            </div>
          </div>
          {server.imported ? (
            <span className="text-[11.5px] text-muted-foreground">{t("Übernommen")}</span>
          ) : server.importable ? (
            <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={importingKey !== null} onClick={() => void importServer(server)}>
              {importingKey === `${server.sourceId}:${server.name}` ? <Loader2 className="size-3.5 animate-spin" /> : t("Übernehmen")}
            </Button>
          ) : null}
        </div>
      ))}
      <p className="px-2 pt-1 text-[11.5px] leading-snug text-muted-foreground">
        {t("„Aktiv über Claude“ nutzt der Agent bereits. Übernehmen macht einen Server unabhängig vom Anbieter und testbar.")}
      </p>
    </div>
  );
}

function McpServersView(props: { project: Project | null; selectedItemId: string | null; onSelect: (itemId: string | null) => void; changeCounter: number; onError: (unknownError: unknown) => void }) {
  const [servers, setServers] = useState<McpServer[]>([]);

  useEffect(() => {
    api.listMcpServers().then(setServers).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.changeCounter]);

  const visibleServers = servers.filter((server) => server.scope === "workspace" || server.projectId === props.project?.id);
  const selectedServer = visibleServers.find((server) => server.id === props.selectedItemId) ?? null;

  const toggleEnabled = async (server: McpServer, enabled: boolean) => {
    const { id: _id, createdAt: _createdAt, envKeys, headerKeys, lastTest: _lastTest, ...serverInput } = server;
    const keepStored = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, ""]));
    await api.updateMcpServer(server.id, { ...serverInput, enabled, env: keepStored(envKeys), headers: keepStored(headerKeys) }).catch(props.onError);
  };

  const detail =
    props.selectedItemId === "new" ? (
      <DetailPane detailKey="new" title={t("MCP-Server hinzufügen")} subtitle={t("Lokal per Befehl oder entfernt per HTTP/SSE. Schon eingerichtete Server aus anderen Tools stehen links unter „Mitgebracht“.")}>
        <McpServerEditor server={null} project={props.project} onDone={props.onSelect} onError={props.onError} />
      </DetailPane>
    ) : selectedServer ? (
      <McpServerDetail server={selectedServer} project={props.project} onDone={props.onSelect} onError={props.onError} />
    ) : (
      <EmptyState
        title={visibleServers.length ? t("Server wählen") : t("Noch keine MCP-Server")}
        description={t("Zusätzliche Tools für den Agent.")}
        action={
          <Button size="sm" onClick={() => props.onSelect("new")}>
            <Plus className="size-3.5" /> {t("MCP-Server hinzufügen")}
          </Button>
        }
      />
    );

  const [importCounter, setImportCounter] = useState(0);
  useEffect(() => {
    if (importCounter) api.listMcpServers().then(setServers).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importCounter]);

  return (
    <MasterDetail
      list={
        <>
        {visibleServers.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{t("Noch keine eigenen MCP-Server.")}</p>
        ) : (
          visibleServers.map((server) => (
            <ListRow
              key={server.id}
              selected={server.id === props.selectedItemId}
              onSelect={() => props.onSelect(server.id)}
              leading={<Switch checked={server.enabled} onCheckedChange={(enabled) => void toggleEnabled(server, enabled)} aria-label={t("Aktiv")} />}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium">{server.name}</span>
                <StatusDot status={!server.enabled || !server.lastTest ? "idle" : server.lastTest.ok ? "running" : "error"} />
                {server.lastTest?.ok && <span className="text-[11px] text-muted-foreground">{server.lastTest.tools.length} {t("Tools")}</span>}
              </div>
              <div className="truncate text-[11.5px] text-muted-foreground">
                {server.scope === "workspace" ? t("Alle Projekte") : t("Nur dieses Projekt")}
                {server.autoAllow && t(" · ohne Nachfrage")}
              </div>
            </ListRow>
          ))
        )}
        <ExternalMcpServers project={props.project} changeCounter={props.changeCounter + importCounter} onImported={() => setImportCounter((count) => count + 1)} onError={props.onError} />
        </>
      }
      detail={detail}
    />
  );
}

function SkillsView(props: { project: Project | null; selectedItemId: string | null; onSelect: (itemId: string | null) => void; changeCounter: number; onError: (unknownError: unknown) => void }) {
  const projectId = props.project?.id ?? null;
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillContent, setSkillContent] = useState<{ key: string; content: string; savedContent: string } | null>(null);
  const [newSkill, setNewSkill] = useState({ scope: (props.project ? "project" : "user") as SkillScope, name: "", description: "", instructions: "" });
  const [saving, setSaving] = useState(false);
  const created = useSavedFlash();
  const skillSaved = useSavedFlash();

  useEffect(() => {
    api.listSkills(projectId).then(setSkills).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, props.changeCounter]);

  const selectedSkill = skills.find((skill) => skillKeyOf(skill) === props.selectedItemId) ?? null;

  useEffect(() => {
    if (!selectedSkill) return setSkillContent(null);
    if (skillContent?.key === skillKeyOf(selectedSkill)) return;
    api
      .readSkillFile(selectedSkill.scope, projectId, selectedSkill.path)
      .then((content) => setSkillContent({ key: skillKeyOf(selectedSkill), content, savedContent: content }))
      .catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSkill?.scope, selectedSkill?.path, projectId]);

  const createSkill = async () => {
    setSaving(true);
    try {
      const trimmedName = newSkill.name.trim();
      await api.createSkill({ ...newSkill, projectId: newSkill.scope === "project" ? projectId : null, name: trimmedName });
      setNewSkill((previous) => ({ ...previous, name: "", description: "", instructions: "" }));
      toast.success(t("Skill „{0}“ angelegt", trimmedName));
      props.onSelect(`${newSkill.scope}:${trimmedName}`);
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const saveSkill = async () => {
    if (!selectedSkill || !skillContent) return;
    setSaving(true);
    try {
      await api.saveSkillFile(selectedSkill.scope, projectId, selectedSkill.path, skillContent.content);
      setSkillContent({ ...skillContent, savedContent: skillContent.content });
      skillSaved.flashSaved();
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const detail =
    props.selectedItemId === "new" ? (
      <DetailPane detailKey="new" title={t("Skill anlegen")} subtitle={t("Format wie Claude Code (SKILL.md) – nutzbar in Harnold und Claude Code.")}>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <FormField label={t("Name")}>
              <Input value={newSkill.name} placeholder="release-notes" onChange={(changeEvent) => setNewSkill((previous) => ({ ...previous, name: changeEvent.target.value.toLowerCase() }))} />
            </FormField>
            <FormField label={t("Ablage")}>
              <Select value={newSkill.scope} onValueChange={(value) => setNewSkill((previous) => ({ ...previous, scope: value as SkillScope }))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {props.project && <SelectItem value="project">{t("Projekt (.claude/skills)")}</SelectItem>}
                  <SelectItem value="user">{t("Nutzer (~/.claude/skills)")}</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>
          <FormField label={t("Wann nutzen?")}>
            <Input value={newSkill.description} placeholder={t("z. B. wenn Release Notes geschrieben werden")} onChange={(changeEvent) => setNewSkill((previous) => ({ ...previous, description: changeEvent.target.value }))} />
          </FormField>
          <FormField label={t("Anleitung (Markdown)")}>
            <Textarea className="min-h-48 font-mono text-[12.5px]" value={newSkill.instructions} onChange={(changeEvent) => setNewSkill((previous) => ({ ...previous, instructions: changeEvent.target.value }))} />
          </FormField>
          <div className="flex gap-2">
            <Button size="sm" disabled={saving || !newSkill.name.trim() || !newSkill.description.trim()} onClick={() => void createSkill()}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {t("Anlegen")}
              <SavedCheck saved={created.saved} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => props.onSelect(null)}>
              {t("Abbrechen")}
            </Button>
          </div>
        </div>
      </DetailPane>
    ) : selectedSkill ? (
      <DetailPane
        detailKey={skillKeyOf(selectedSkill)}
        title={selectedSkill.name}
        subtitle={`${selectedSkill.scope === "project" ? t("Projekt") : t("Nutzer")} · ${selectedSkill.description || t("Keine Beschreibung")}`}
        actions={
          <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            {t("Aktiv")}
            <Switch checked={selectedSkill.enabled} onCheckedChange={(enabled) => void api.setSkillEnabled(selectedSkill.name, enabled).catch(props.onError)} />
          </label>
        }
      >
        {skillContent && (
          <div className="grid gap-2">
            <Textarea className="min-h-[420px] font-mono text-[12.5px]" value={skillContent.content} onChange={(changeEvent) => setSkillContent({ ...skillContent, content: changeEvent.target.value })} />
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={saving || skillContent.content === skillContent.savedContent} onClick={() => void saveSkill()}>
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                {t("Speichern")}
                <SavedCheck saved={skillSaved.saved} />
              </Button>
              {skillContent.content !== skillContent.savedContent && (
                <span className="text-[11.5px] text-muted-foreground">{t("Ungespeichert")}</span>
              )}
            </div>
          </div>
        )}
      </DetailPane>
    ) : (
      <EmptyState
        title={skills.length ? t("Skill wählen") : t("Keine Skills gefunden")}
        description={t("Aus ~/.claude/skills und .claude/skills im Projekt.")}
        action={
          <Button size="sm" onClick={() => props.onSelect("new")}>
            <Plus className="size-3.5" /> {t("Skill anlegen")}
          </Button>
        }
      />
    );

  return (
    <MasterDetail
      list={
        skills.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{t("Keine Skills.")}</p>
        ) : (
          skills.map((skill) => (
            <ListRow
              key={skillKeyOf(skill)}
              selected={skillKeyOf(skill) === props.selectedItemId}
              onSelect={() => props.onSelect(skillKeyOf(skill))}
              leading={<Switch checked={skill.enabled} onCheckedChange={(enabled) => void api.setSkillEnabled(skill.name, enabled).catch(props.onError)} aria-label={t("Aktiv")} />}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium">{skill.name}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">{skill.scope === "project" ? t("Projekt") : t("Nutzer")}</span>
              </div>
              <div className="line-clamp-2 text-[11.5px] text-muted-foreground">{skill.description || t("Keine Beschreibung")}</div>
            </ListRow>
          ))
        )
      }
      detail={detail}
    />
  );
}

export function IntegrationsScreen(props: IntegrationsScreenProps) {
  return (
    <ScreenLayout
      title={t("Integrationen")}
      tabs={
        <SegmentedControl
          className="w-72"
          options={[
            { value: "mcp", label: t("MCP-Server") },
            { value: "skills", label: t("Skills") },
            { value: "plugins", label: t("Plugins") },
          ]}
          value={props.activeTab}
          onValueChange={(tab) => props.onNavigate(tab, null)}
        />
      }
      actions={
        <Button size="sm" variant="secondary" onClick={() => props.onNavigate(props.activeTab, "new")}>
          <Plus className="size-3.5" /> {props.activeTab === "mcp" ? t("MCP-Server hinzufügen") : props.activeTab === "plugins" ? t("Ordner hinzufügen") : t("Skill anlegen")}
        </Button>
      }
    >
      {props.activeTab === "mcp" ? (
        <McpServersView
          key="mcp"
          project={props.project}
          selectedItemId={props.selectedItemId}
          onSelect={(itemId) => props.onNavigate("mcp", itemId)}
          changeCounter={props.integrationsChangeCounter}
          onError={props.onError}
        />
      ) : props.activeTab === "plugins" ? (
        <PluginsView
          key="plugins"
          selectedItemId={props.selectedItemId}
          onSelect={(itemId) => props.onNavigate("plugins", itemId)}
          changeCounter={props.integrationsChangeCounter}
          onError={props.onError}
        />
      ) : (
        <SkillsView
          key="skills"
          project={props.project}
          selectedItemId={props.selectedItemId}
          onSelect={(itemId) => props.onNavigate("skills", itemId)}
          changeCounter={props.integrationsChangeCounter}
          onError={props.onError}
        />
      )}
    </ScreenLayout>
  );
}
