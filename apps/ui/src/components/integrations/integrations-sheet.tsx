import { useEffect, useState } from "react";
import { Braces, Check, Loader2, Plug, Plus, Trash2, X } from "lucide-react";
import { api } from "@/api";
import type { McpServer, McpServerInput, McpTransport, Project, Skill, SkillScope } from "@/types";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { SegmentedControl } from "@/components/segmented-control";
import { StatusDot } from "@/components/status-dot";
import { FormField } from "@/components/form-field";

type IntegrationsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  /** Bumped on every `integrations_changed` event. */
  integrationsChangeCounter: number;
  onError: (unknownError: unknown) => void;
};

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
              placeholder={row.stored ? "gespeichert" : "Wert"}
              value={row.value}
              onChange={(changeEvent) => updateRow(rowIndex, { value: changeEvent.target.value })}
            />
            <Button variant="ghost" size="icon" className="size-9 shrink-0 text-muted-foreground" onClick={() => props.onChange(props.rows.filter((_, index) => index !== rowIndex))} aria-label="Entfernen">
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="sm" className="h-7 justify-self-start gap-1.5 px-2 text-[12px] text-muted-foreground" onClick={() => props.onChange([...props.rows, { key: "", value: "", stored: false }])}>
          <Plus className="size-3.5" /> Hinzufügen
        </Button>
      </div>
    </FormField>
  );
}

const toRecord = (rows: KeyValueRow[]) => Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));

function McpServerEditor(props: { server: McpServer | null; project: Project | null; onDone: () => void; onError: (unknownError: unknown) => void }) {
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

  const updateInput = (changes: Partial<McpServerInput>) => setServerInput((previous) => ({ ...previous, ...changes }));

  const save = async () => {
    setSaving(true);
    try {
      if (jsonMode) {
        for (const importedInput of parseMcpJson(jsonText, serverInput.scope, serverInput.projectId)) await api.createMcpServer(importedInput);
      } else {
        const [command = "", ...commandArguments] = splitCommandLine(commandLine);
        const completeInput: McpServerInput = { ...serverInput, command, args: commandArguments, env: toRecord(envRows), headers: toRecord(headerRows) };
        if (existingServer) await api.updateMcpServer(existingServer.id, completeInput);
        else await api.createMcpServer(completeInput);
      }
      props.onDone();
    } catch (saveError) {
      props.onError(saveError instanceof SyntaxError ? new Error("Ungültiges JSON") : saveError);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existingServer || !window.confirm(`MCP-Server „${existingServer.name}“ entfernen?`)) return;
    await api.deleteMcpServer(existingServer.id).then(props.onDone).catch(props.onError);
  };

  return (
    <div className="grid gap-4 py-4">
      {!existingServer && (
        <SegmentedControl
          options={[
            { value: "form", label: "Formular" },
            { value: "json", label: "JSON einfügen" },
          ]}
          value={jsonMode ? "json" : "form"}
          onValueChange={(value) => setJsonMode(value === "json")}
        />
      )}

      <FormField label="Gültig für">
        <Select value={serverInput.scope} onValueChange={(value) => updateInput({ scope: value as McpServerInput["scope"], projectId: value === "project" ? (props.project?.id ?? null) : null })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {props.project && <SelectItem value="project">Projekt „{props.project.name}“</SelectItem>}
            <SelectItem value="workspace">Alle Projekte</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {jsonMode ? (
        <FormField label="Konfiguration" hint="Format wie in Claude Desktop / Claude Code (mcpServers). Mehrere Server möglich.">
          <Textarea
            className="min-h-40 animate-in font-mono text-[12.5px] fade-in duration-200"
            placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'}
            value={jsonText}
            onChange={(changeEvent) => setJsonText(changeEvent.target.value)}
          />
        </FormField>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <FormField label="Name" hint="Tools heißen dann mcp__name__tool.">
              <Input value={serverInput.name} placeholder="github" onChange={(changeEvent) => updateInput({ name: changeEvent.target.value })} />
            </FormField>
            <FormField label="Verbindung">
              <SegmentedControl
                className="w-52"
                options={[
                  { value: "stdio", label: "Lokal" },
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
              <FormField label="Befehl" hint="Wird im Projektordner gestartet.">
                <Input className="font-mono text-[12.5px]" value={commandLine} placeholder="npx -y @modelcontextprotocol/server-github" onChange={(changeEvent) => setCommandLine(changeEvent.target.value)} />
              </FormField>
              <KeyValueEditor label="Umgebungsvariablen" hint="Verschlüsselt gespeichert." rows={envRows} keyPlaceholder="GITHUB_TOKEN" onChange={setEnvRows} />
            </>
          ) : (
            <>
              <FormField label="URL">
                <Input className="font-mono text-[12.5px]" value={serverInput.url} placeholder="https://example.com/mcp" onChange={(changeEvent) => updateInput({ url: changeEvent.target.value })} />
              </FormField>
              <KeyValueEditor label="Header" hint="z. B. Authorization: Bearer …  Verschlüsselt gespeichert." rows={headerRows} keyPlaceholder="Authorization" onChange={setHeaderRows} />
            </>
          )}

          <label className="flex items-center justify-between gap-4 text-[13px]">
            <span>
              Tools ohne Nachfrage erlauben
              <span className="block text-[11.5px] text-muted-foreground">Sonst gilt der Permission-Modus der Session.</span>
            </span>
            <Switch checked={serverInput.autoAllow} onCheckedChange={(autoAllow) => updateInput({ autoAllow })} />
          </label>
        </>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {existingServer ? "Speichern" : jsonMode ? "Importieren" : "Hinzufügen"}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onDone}>
          Abbrechen
        </Button>
        {existingServer && (
          <Button size="sm" variant="ghost" className="ml-auto gap-1.5 text-muted-foreground hover:text-destructive" onClick={() => void remove()}>
            <Trash2 className="size-3.5" /> Entfernen
          </Button>
        )}
      </div>
    </div>
  );
}

function McpServersTab(props: { project: Project | null; changeCounter: number; onError: (unknownError: unknown) => void }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [testingServerIds, setTestingServerIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.listMcpServers().then(setServers).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.changeCounter]);

  const visibleServers = servers.filter((server) => server.scope === "workspace" || server.projectId === props.project?.id);

  const runTest = async (server: McpServer) => {
    setTestingServerIds((previous) => new Set(previous).add(server.id));
    await api.testMcpServer(server.id).catch(props.onError);
    setTestingServerIds((previous) => {
      const next = new Set(previous);
      next.delete(server.id);
      return next;
    });
  };

  const toggleEnabled = async (server: McpServer, enabled: boolean) => {
    const { id: _id, createdAt: _createdAt, envKeys, headerKeys, lastTest: _lastTest, ...serverInput } = server;
    const keepStored = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, ""]));
    await api.updateMcpServer(server.id, { ...serverInput, enabled, env: keepStored(envKeys), headers: keepStored(headerKeys) }).catch(props.onError);
  };

  return (
    <div className="animate-in fade-in duration-200">
      <Collapsible open={editingServerId === "new"}>
        {editingServerId !== "new" && (
          <Button size="sm" variant="secondary" className="mb-2" onClick={() => setEditingServerId("new")}>
            <Plus className="size-3.5" /> MCP-Server hinzufügen
          </Button>
        )}
        <CollapsibleContent className="collapsible-animated">
          <div className="mb-3 rounded-xl border bg-card px-4">
            {editingServerId === "new" && <McpServerEditor server={null} project={props.project} onDone={() => setEditingServerId(null)} onError={props.onError} />}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {visibleServers.length === 0 && editingServerId !== "new" && (
        <p className="py-6 text-center text-[13px] text-muted-foreground">Noch keine MCP-Server. Server aus `.mcp.json` und `~/.claude.json` lädt der Agent zusätzlich.</p>
      )}

      <ul className="grid gap-1.5">
        {visibleServers.map((server) => {
          const expanded = editingServerId === server.id;
          const testing = testingServerIds.has(server.id);
          const statusOfServer = !server.enabled || !server.lastTest ? "idle" : server.lastTest.ok ? "running" : "error";
          return (
            <li key={server.id} className={cn("rounded-xl border transition-colors duration-200", expanded ? "bg-card" : "border-transparent hover:bg-foreground/[0.03]")}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <Switch checked={server.enabled} onCheckedChange={(enabled) => void toggleEnabled(server, enabled)} aria-label="Aktiv" />
                <button className="min-w-0 flex-1 text-left" onClick={() => setEditingServerId(expanded ? null : server.id)}>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium">{server.name}</span>
                    <StatusDot status={statusOfServer} />
                    {server.lastTest?.ok && <span className="text-[11.5px] text-muted-foreground">{server.lastTest.tools.length} Tools</span>}
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-muted-foreground">
                    {server.transport === "stdio" ? joinCommandLine([server.command, ...server.args]) : server.url}
                  </div>
                  <div className="text-[11.5px] text-muted-foreground">
                    {server.scope === "workspace" ? "Alle Projekte" : "Nur dieses Projekt"}
                    {server.autoAllow && " · ohne Nachfrage"}
                  </div>
                  {server.lastTest && !server.lastTest.ok && <div className="mt-0.5 line-clamp-2 text-[12px] text-destructive">{server.lastTest.error}</div>}
                </button>
                <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1.5 px-2 text-[12px] text-muted-foreground" disabled={testing} onClick={() => void runTest(server)}>
                  {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />} Testen
                </Button>
              </div>

              {server.lastTest?.ok && server.lastTest.tools.length > 0 && !expanded && (
                <div className="flex animate-in flex-wrap gap-1 px-3 pb-2.5 pl-[60px] fade-in duration-200">
                  {server.lastTest.tools.slice(0, 12).map((serverTool) => (
                    <span key={serverTool.name} title={serverTool.description} className="rounded bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground">
                      {serverTool.name}
                    </span>
                  ))}
                  {server.lastTest.tools.length > 12 && <span className="text-[11px] text-muted-foreground">+{server.lastTest.tools.length - 12}</span>}
                </div>
              )}

              <Collapsible open={expanded}>
                <CollapsibleContent className="collapsible-animated">
                  <div className="border-t px-4">
                    {expanded && <McpServerEditor server={server} project={props.project} onDone={() => setEditingServerId(null)} onError={props.onError} />}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type SkillEditorState = { mode: "new" } | { mode: "edit"; skill: Skill; content: string; savedContent: string };

function SkillsTab(props: { project: Project | null; changeCounter: number; onError: (unknownError: unknown) => void }) {
  const projectId = props.project?.id ?? null;
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editorState, setEditorState] = useState<SkillEditorState | null>(null);
  const [newSkill, setNewSkill] = useState({ scope: (props.project ? "project" : "user") as SkillScope, name: "", description: "", instructions: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.listSkills(projectId).then(setSkills).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, props.changeCounter]);

  const skillKey = (skill: Skill) => `${skill.scope}:${skill.path}`;

  const openSkill = async (skill: Skill) => {
    if (editorState?.mode === "edit" && skillKey(editorState.skill) === skillKey(skill)) return setEditorState(null);
    try {
      const content = await api.readSkillFile(skill.scope, projectId, skill.path);
      setEditorState({ mode: "edit", skill, content, savedContent: content });
    } catch (readError) {
      props.onError(readError);
    }
  };

  const saveSkill = async () => {
    if (!editorState) return;
    setSaving(true);
    try {
      if (editorState.mode === "new") {
        await api.createSkill({ ...newSkill, projectId: newSkill.scope === "project" ? projectId : null, name: newSkill.name.trim() });
        setNewSkill((previous) => ({ ...previous, name: "", description: "", instructions: "" }));
        setEditorState(null);
      } else {
        await api.saveSkillFile(editorState.skill.scope, projectId, editorState.skill.path, editorState.content);
        setEditorState({ ...editorState, savedContent: editorState.content });
      }
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="animate-in fade-in duration-200">
      <Collapsible open={editorState?.mode === "new"}>
        {editorState?.mode !== "new" && (
          <Button size="sm" variant="secondary" className="mb-2" onClick={() => setEditorState({ mode: "new" })}>
            <Plus className="size-3.5" /> Skill anlegen
          </Button>
        )}
        <CollapsibleContent className="collapsible-animated">
          <div className="mb-3 grid gap-4 rounded-xl border bg-card p-4">
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Name" hint="Kleinbuchstaben und -">
                <Input value={newSkill.name} placeholder="release-notes" onChange={(changeEvent) => setNewSkill((previous) => ({ ...previous, name: changeEvent.target.value.toLowerCase() }))} />
              </FormField>
              <FormField label="Ablage">
                <Select value={newSkill.scope} onValueChange={(value) => setNewSkill((previous) => ({ ...previous, scope: value as SkillScope }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {props.project && <SelectItem value="project">Projekt (.claude/skills)</SelectItem>}
                    <SelectItem value="user">Nutzer (~/.claude/skills)</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <FormField label="Beschreibung" hint="Wann der Agent den Skill nutzen soll.">
              <Input value={newSkill.description} onChange={(changeEvent) => setNewSkill((previous) => ({ ...previous, description: changeEvent.target.value }))} />
            </FormField>
            <FormField label="Anleitung (Markdown)">
              <Textarea className="min-h-32 font-mono text-[12.5px]" value={newSkill.instructions} onChange={(changeEvent) => setNewSkill((previous) => ({ ...previous, instructions: changeEvent.target.value }))} />
            </FormField>
            <div className="flex gap-2">
              <Button size="sm" disabled={saving || !newSkill.name.trim() || !newSkill.description.trim()} onClick={() => void saveSkill()}>
                Anlegen
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditorState(null)}>
                Abbrechen
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {skills.length === 0 && editorState?.mode !== "new" && (
        <p className="py-6 text-center text-[13px] text-muted-foreground">Keine Skills gefunden. Format wie Claude Code (SKILL.md).</p>
      )}

      <ul className="grid gap-1.5">
        {skills.map((skill) => {
          const expanded = editorState?.mode === "edit" && skillKey(editorState.skill) === skillKey(skill);
          return (
            <li key={skillKey(skill)} className={cn("rounded-xl border transition-colors duration-200", expanded ? "bg-card" : "border-transparent hover:bg-foreground/[0.03]")}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <Switch checked={skill.enabled} onCheckedChange={(enabled) => void api.setSkillEnabled(skill.name, enabled).catch(props.onError)} aria-label="Aktiv" />
                <button className="min-w-0 flex-1 text-left" onClick={() => void openSkill(skill)}>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium">{skill.name}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">{skill.scope === "project" ? "Projekt" : "Nutzer"}</span>
                  </div>
                  <div className="line-clamp-2 text-[12px] text-muted-foreground">{skill.description || "Keine Beschreibung"}</div>
                </button>
              </div>
              <Collapsible open={expanded}>
                <CollapsibleContent className="collapsible-animated">
                  {expanded && editorState?.mode === "edit" && (
                    <div className="grid gap-2 border-t p-3">
                      <Textarea
                        className="min-h-64 font-mono text-[12.5px]"
                        value={editorState.content}
                        onChange={(changeEvent) => setEditorState({ ...editorState, content: changeEvent.target.value })}
                      />
                      <div className="flex items-center gap-2">
                        <Button size="sm" disabled={saving || editorState.content === editorState.savedContent} onClick={() => void saveSkill()}>
                          Speichern
                        </Button>
                        <span className="text-[11.5px] text-muted-foreground">
                          {editorState.content === editorState.savedContent ? (
                            <span className="inline-flex items-center gap-1">
                              <Check className="size-3" /> Gespeichert
                            </span>
                          ) : (
                            "Ungespeichert"
                          )}
                        </span>
                      </div>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function IntegrationsSheet(props: IntegrationsSheetProps) {
  const [activeTab, setActiveTab] = useState<"mcp" | "skills">("mcp");

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-[560px]">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <Braces className="size-4 text-muted-foreground" /> Integrationen
          </SheetTitle>
          <SheetDescription>MCP-Server und Skills für den Agent{props.project ? ` – Ansicht für „${props.project.name}“` : ""}.</SheetDescription>
        </SheetHeader>

        <div className="border-b px-4 py-2.5">
          <SegmentedControl
            options={[
              { value: "mcp", label: "MCP-Server" },
              { value: "skills", label: "Skills" },
            ]}
            value={activeTab}
            onValueChange={setActiveTab}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {props.open &&
            (activeTab === "mcp" ? (
              <McpServersTab key="mcp" project={props.project} changeCounter={props.integrationsChangeCounter} onError={props.onError} />
            ) : (
              <SkillsTab key="skills" project={props.project} changeCounter={props.integrationsChangeCounter} onError={props.onError} />
            ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

