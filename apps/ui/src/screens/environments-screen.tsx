import { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, CircleAlert, Download, Loader2, Lock, LockOpen, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { api } from "@/api";
import type { ClaudeAuthStatus, Environment, EnvironmentAccountChecks, EnvironmentClaudeMode, EnvironmentInput, EnvironmentProvider, EnvironmentVariable, Project } from "@/types";
import { SegmentedControl } from "@/components/segmented-control";
import { ClaudeAccountSection } from "@/components/claude-connection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FormField } from "@/components/form-field";
import { ModelSelect, modelLabel } from "@/components/model-select";
import { ProjectAvatar } from "@/components/project-avatar";
import { ProjectIconDialog } from "@/components/project-icon-dialog";
import { DetailPane, EmptyState, ListRow, MasterDetail, ScreenLayout } from "./screen-layout";
import { confirmAction } from "@/components/confirm-dialog";

type EnvironmentsScreenProps = {
  workspaceDefaultModel: string;
  /** Selected environment id, "new" for the create form, null for none. */
  selection: string | null;
  onSelect: (selection: string | null) => void;
  environments: Environment[];
  projects: Project[];
  onEnvironmentsChange: () => void;
  /** Opens the environment's memory (notes + files shared by all its projects). */
  onOpenMemory: (environment: Environment) => void;
  onSaved: (message: string) => void;
  onError: (unknownError: unknown) => void;
};

const accountSummary = (environment: Environment) =>
  [environment.claudeMode !== "inherit" && "eigenes Claude", environment.model && modelLabel(environment.model), ...environment.accounts.map((account) => account.label), environment.sshKeyPath && "SSH", environment.variables.length && `${environment.variables.length} Variablen`].filter(Boolean).join(" · ") ||
  "noch keine Konten";

export function EnvironmentsScreen(props: EnvironmentsScreenProps) {
  const [providers, setProviders] = useState<EnvironmentProvider[]>([]);
  const { onError } = props;
  useEffect(() => {
    api.listEnvironmentProviders().then(setProviders).catch(onError);
  }, [onError]);
  const selectedEnvironment = props.environments.find((environment) => environment.id === props.selection) ?? null;
  const [iconDialogEnvironment, setIconDialogEnvironment] = useState<Environment | null>(null);
  const saveEnvironmentIcon = (icon: string | null) => {
    if (!iconDialogEnvironment) return;
    api.updateEnvironmentIcon(iconDialogEnvironment.id, icon).then(props.onEnvironmentsChange).catch(props.onError);
  };
  return (
    <ScreenLayout
      title="Umgebungen"
      actions={
        <Button size="sm" className="gap-1.5" onClick={() => props.onSelect("new")}>
          <Plus className="size-3.5" /> Neue Umgebung
        </Button>
      }
    >
      <MasterDetail
        list={
          props.environments.length === 0 ? (
            <p className="p-3 text-[12.5px] text-muted-foreground">Noch keine Umgebungen.</p>
          ) : (
            props.environments.map((environment) => (
              <ListRow
                key={environment.id}
                selected={environment.id === props.selection}
                onSelect={() => props.onSelect(environment.id)}
                leading={<ProjectAvatar name={environment.name} icon={environment.icon} className="size-8 rounded-lg text-[13px]" />}
              >
                <div className="truncate text-[13px] font-medium">{environment.name}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {environment.projectIds.length} Projekte · {accountSummary(environment)}
                </div>
              </ListRow>
            ))
          )
        }
        detail={
          props.selection === "new" || selectedEnvironment ? (
            <EnvironmentEditor
              key={selectedEnvironment?.id ?? "new"}
              environment={selectedEnvironment}
              providers={providers}
              workspaceDefaultModel={props.workspaceDefaultModel}
              allEnvironments={props.environments}
              projects={props.projects}
              onOpenMemory={props.onOpenMemory}
              onEditIcon={setIconDialogEnvironment}
              onSaved={(savedEnvironment) => {
                props.onEnvironmentsChange();
                props.onSelect(savedEnvironment.id);
                props.onSaved(`Umgebung „${savedEnvironment.name}“ gespeichert`);
              }}
              onDeleted={() => {
                props.onEnvironmentsChange();
                props.onSelect(null);
              }}
              onCancel={() => props.onSelect(null)}
              onError={props.onError}
            />
          ) : (
            <EmptyState
              title={props.environments.length ? "Umgebung auswählen" : "Noch keine Umgebung"}
              action={
                <Button size="sm" onClick={() => props.onSelect("new")}>
                  <Plus className="size-3.5" /> Neue Umgebung
                </Button>
              }
            />
          )
        }
      />
      <ProjectIconDialog target={iconDialogEnvironment} onOpenChange={(open) => !open && setIconDialogEnvironment(null)} onSave={saveEnvironmentIcon} />
    </ScreenLayout>
  );
}

/** Token field: empty keeps the stored token; "Entfernen" clears it. */
function TokenField(props: { label: string; id: string; hint?: string; stored: boolean; value: string | undefined; placeholder: string; check?: EnvironmentAccountChecks[string]; onChange: (value: string | undefined) => void }) {
  const removed = props.value === "" && props.stored;
  return (
    <FormField label={props.label} htmlFor={props.id} hint={props.hint}>
      <div className="flex gap-1.5">
        <Input
          id={props.id}
          type="password"
          autoComplete="off"
          className="font-mono text-[12.5px]"
          value={props.value ?? ""}
          placeholder={removed ? "wird entfernt" : props.stored ? "gespeichert – leer lassen zum Behalten" : props.placeholder}
          onChange={(changeEvent) => props.onChange(changeEvent.target.value || undefined)}
        />
        {props.stored && !removed && (
          <Button type="button" variant="ghost" size="sm" className="h-9 text-muted-foreground" onClick={() => props.onChange("")}>
            Entfernen
          </Button>
        )}
      </div>
      {props.check && (
        <p className={`flex animate-in items-center gap-1.5 text-[12px] fade-in duration-150 ${props.check.ok ? "text-status-running" : "text-destructive"}`}>
          {props.check.ok ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
          {props.check.ok ? `Verbunden als ${props.check.detail}` : props.check.detail}
        </p>
      )}
    </FormField>
  );
}

function EnvironmentEditor(props: {
  environment: Environment | null;
  providers: EnvironmentProvider[];
  workspaceDefaultModel: string;
  allEnvironments: Environment[];
  projects: Project[];
  onOpenMemory: (environment: Environment) => void;
  onEditIcon: (environment: Environment) => void;
  onSaved: (savedEnvironment: Environment) => void;
  onDeleted: () => void;
  onCancel: () => void;
  onError: (unknownError: unknown) => void;
}) {
  const existing = props.environment;
  const [draft, setDraft] = useState<EnvironmentInput>(() => draftFrom(existing));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ found: string[]; notFound: string[] } | null>(null);
  const [accountChecks, setAccountChecks] = useState<EnvironmentAccountChecks>({});

  // Changes from elsewhere (e.g. the agent) show up as long as nothing is being edited here.
  useEffect(() => {
    if (!dirty) setDraft(draftFrom(existing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing]);

  const update = (changes: Partial<EnvironmentInput>) => {
    setDirty(true);
    setDraft((previous) => ({ ...previous, ...changes }));
  };

  const importCurrent = async () => {
    if (!existing) return;
    setImporting(true);
    try {
      const result = await api.importCurrentAccounts(existing.id);
      setDirty(false);
      setDraft(draftFrom(result.environment));
      setImportResult(result);
    } catch (importError) {
      props.onError(importError);
    } finally {
      setImporting(false);
    }
  };
  const updateVariable = (variableIndex: number, changes: Partial<EnvironmentVariable>) =>
    update({ variables: draft.variables.map((variable, index) => (index === variableIndex ? { ...variable, ...changes } : variable)) });
  const storedSecretKeys = new Set(existing?.variables.filter((variable) => variable.secret).map((variable) => variable.key) ?? []);

  const save = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    try {
      const input: EnvironmentInput = { ...draft, variables: draft.variables.filter((variable) => variable.key.trim()).map((variable) => ({ ...variable, key: variable.key.trim() })) };
      const savedEnvironment = existing ? await api.updateEnvironment(existing.id, input) : await api.createEnvironment(input);
      setAccountChecks({});
      setDirty(false);
      setDraft(draftFrom(savedEnvironment));
      props.onSaved(savedEnvironment);
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const checkAccounts = async () => {
    if (!existing) return;
    setChecking(true);
    try {
      setAccountChecks(await api.checkEnvironmentAccounts(existing.id));
    } catch (checkError) {
      props.onError(checkError);
    } finally {
      setChecking(false);
    }
  };

  const remove = async () => {
    if (!existing || !(await confirmAction({ title: `Umgebung „${existing.name}“ löschen?`, description: "Ihre Projekte nutzen danach die Konten des Rechners. Gespeicherte Tokens gehen verloren." }))) return;
    api.deleteEnvironment(existing.id).then(props.onDeleted).catch(props.onError);
  };

  const environmentNameOf = (projectId: string) => props.allEnvironments.find((environment) => environment.id !== existing?.id && environment.projectIds.includes(projectId))?.name;
  const toggleProject = (projectId: string) =>
    update({ projectIds: draft.projectIds.includes(projectId) ? draft.projectIds.filter((id) => id !== projectId) : [...draft.projectIds, projectId] });

  return (
    <DetailPane
      detailKey={existing?.id ?? "new"}
      title={existing ? existing.name : "Neue Umgebung"}
      actions={
        existing && (
          <>
            <Button size="icon" variant="ghost" className="size-7" aria-label="Icon ändern" title="Icon ändern" onClick={() => props.onEditIcon(existing)}>
              <ProjectAvatar name={existing.name} icon={existing.icon} className="size-5" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 gap-1.5 px-2 text-[12px]"
              disabled={!existing.projectIds.length}
              title={existing.projectIds.length ? "Notizen und Dateien für alle Projekte dieser Umgebung" : "Erst ein Projekt zuordnen"}
              onClick={() => props.onOpenMemory(existing)}
            >
              <BookOpen className="size-3.5" /> Kontext
            </Button>
            <Button size="sm" variant="secondary" className="h-7 gap-1.5 px-2 text-[12px]" disabled={checking || !existing.accounts.some((account) => props.providers.find((provider) => provider.id === account.provider)?.checkable)} onClick={() => void checkAccounts()}>
              {checking ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />} Konten prüfen
            </Button>
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={remove} aria-label="Löschen">
              <Trash2 className="size-3.5" />
            </Button>
          </>
        )
      }
    >
      <form
        className="grid gap-6"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          void save();
        }}
      >
        <FormField label="Name" htmlFor="environment-name">
          <Input id="environment-name" autoFocus={!existing} value={draft.name} placeholder="z. B. Kasoria" onChange={(changeEvent) => update({ name: changeEvent.target.value })} />
        </FormField>

        <AiSection
          environment={existing}
          claudeMode={draft.claudeMode}
          claudeApiKey={draft.claudeApiKey}
          model={draft.model}
          workspaceDefaultModel={props.workspaceDefaultModel}
          onChange={update}
          onError={props.onError}
        />

        <AccountsSection
          providers={props.providers}
          accounts={draft.accounts}
          storedAccounts={existing?.accounts ?? []}
          checks={accountChecks}
          importing={importing}
          importResult={importResult}
          onImport={existing ? () => void importCurrent() : undefined}
          onChange={(accounts) => update({ accounts })}
        />

        <section className="grid gap-4">
          <h3 className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">Git</h3>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Name" htmlFor="environment-git-name">
              <Input id="environment-git-name" value={draft.gitName} placeholder="Commit-Autor" onChange={(changeEvent) => update({ gitName: changeEvent.target.value })} />
            </FormField>
            <FormField label="E-Mail" htmlFor="environment-git-email">
              <Input id="environment-git-email" value={draft.gitEmail} placeholder="name@firma.de" onChange={(changeEvent) => update({ gitEmail: changeEvent.target.value })} />
            </FormField>
          </div>
          <FormField label="SSH-Key" htmlFor="environment-ssh">
            <Input id="environment-ssh" className="font-mono text-[12.5px]" value={draft.sshKeyPath} placeholder="~/.ssh/id_ed25519" onChange={(changeEvent) => update({ sshKeyPath: changeEvent.target.value })} />
          </FormField>
        </section>

        <section className="grid gap-2">
          <h3 className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">Variablen</h3>
          {draft.variables.map((variable, variableIndex) => (
            <div key={variableIndex} className="flex animate-in gap-1.5 fade-in duration-150">
              <Input className="w-2/5 font-mono text-[12.5px]" placeholder="SUPABASE_ACCESS_TOKEN" value={variable.key} onChange={(changeEvent) => updateVariable(variableIndex, { key: changeEvent.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} />
              <Input
                type={variable.secret ? "password" : "text"}
                autoComplete="off"
                className="flex-1 font-mono text-[12.5px]"
                placeholder={variable.secret && storedSecretKeys.has(variable.key) ? "gespeichert" : "Wert"}
                value={variable.value}
                onChange={(changeEvent) => updateVariable(variableIndex, { value: changeEvent.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 text-muted-foreground"
                title={variable.secret ? "Geheim (verschlüsselt)" : "Sichtbar"}
                onClick={() => updateVariable(variableIndex, { secret: !variable.secret })}
                aria-label="Geheim umschalten"
              >
                {variable.secret ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0 text-muted-foreground" onClick={() => update({ variables: draft.variables.filter((_, index) => index !== variableIndex) })} aria-label="Entfernen">
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" className="h-7 justify-self-start gap-1.5 px-2 text-[12px] text-muted-foreground" onClick={() => update({ variables: [...draft.variables, { key: "", value: "", secret: true }] })}>
            <Plus className="size-3.5" /> Variable
          </Button>
        </section>

        <section className="grid gap-2">
          <h3 className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">Projekte</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.projectIds.map((projectId) => {
              const project = props.projects.find((candidate) => candidate.id === projectId);
              if (!project) return null;
              return (
                <span key={projectId} className="inline-flex animate-in items-center gap-1.5 rounded-md border bg-background py-0.5 pr-1 pl-1.5 text-[12px] fade-in duration-150">
                  <ProjectAvatar name={project.name} icon={project.icon} className="size-4 text-[9px]" />
                  <span className="max-w-56 truncate">{project.name}</span>
                  <button type="button" className="rounded text-muted-foreground transition-colors hover:text-foreground" onClick={() => toggleProject(projectId)} aria-label="Entfernen">
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[12px] text-muted-foreground">
                  <Plus className="size-3.5" /> Projekt zuordnen
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
                <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">Ein Projekt gehört zu genau einer Umgebung. Rechts: aktuelle.</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {props.projects.length === 0 && <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground">Keine Projekte.</p>}
                {props.projects.map((project) => (
                  <DropdownMenuCheckboxItem
                    key={project.id}
                    checked={draft.projectIds.includes(project.id)}
                    onSelect={(selectEvent) => selectEvent.preventDefault()}
                    onCheckedChange={() => toggleProject(project.id)}
                    className="text-[13px]"
                  >
                    <span className="truncate">{project.name}</span>
                    {environmentNameOf(project.id) && <span className="ml-auto shrink-0 pl-3 text-[11px] text-muted-foreground">{environmentNameOf(project.id)}</span>}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </section>

        <div className="flex gap-2 border-t pt-4">
          <Button type="submit" size="sm" disabled={!draft.name.trim() || saving}>
            {saving && <Loader2 className="size-3.5 animate-spin" />} {existing ? "Speichern" : "Anlegen"}
          </Button>
          {!existing && (
            <Button type="button" size="sm" variant="ghost" onClick={props.onCancel}>
              Abbrechen
            </Button>
          )}
        </div>
      </form>
    </DetailPane>
  );
}

/** KI per environment: which Claude access (workspace setting, own Claude login, own API key) and the default model. */
function AiSection(props: {
  environment: Environment | null;
  workspaceDefaultModel: string;
  claudeMode: EnvironmentClaudeMode;
  claudeApiKey: string | undefined;
  model: string;
  onChange: (changes: Partial<EnvironmentInput>) => void;
  onError: (unknownError: unknown) => void;
}) {
  const [accountStatus, setAccountStatus] = useState<ClaudeAuthStatus | null>(null);
  const environmentId = props.environment?.id;
  const { onError } = props;

  useEffect(() => {
    if (props.claudeMode !== "subscription" || !environmentId) return;
    api.readClaudeStatus(false, environmentId).then(setAccountStatus).catch(onError);
  }, [props.claudeMode, environmentId, onError]);

  return (
    <section className="grid gap-4">
      <h3 className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">KI</h3>
      <FormField label="Claude-Zugang">
        <SegmentedControl
          className="w-96"
          options={[
            { value: "inherit", label: "Wie Einstellungen" },
            { value: "subscription", label: "Claude-Konto" },
            { value: "apiKey", label: "API-Key" },
          ]}
          value={props.claudeMode}
          onValueChange={(claudeMode) => props.onChange({ claudeMode })}
        />
      </FormField>

      {props.claudeMode === "subscription" &&
        (environmentId ? (
          accountStatus ? (
            <ClaudeAccountSection environmentId={environmentId} status={accountStatus} onStatusChange={setAccountStatus} onError={onError} />
          ) : (
            <div className="h-16" />
          )
        ) : (
          <p className="text-[12px] text-muted-foreground">Nach dem Anlegen anmelden.</p>
        ))}

      {props.claudeMode === "apiKey" && (
        <TokenField
          label="Anthropic API-Key"
          id="environment-claude-key"
          stored={props.environment?.claudeApiKeySet ?? false}
          value={props.claudeApiKey}
          placeholder="sk-ant-…"
          onChange={(claudeApiKey) => props.onChange({ claudeApiKey })}
        />
      )}

      <FormField label="Modell">
        <ModelSelect value={props.model} onChange={(model) => props.onChange({ model })} inherited={{ model: props.workspaceDefaultModel, source: "Einstellungen" }} />
      </FormField>
    </section>
  );
}

function draftFrom(environment: Environment | null): EnvironmentInput {
  return {
    name: environment?.name ?? "",
    gitName: environment?.gitName ?? "",
    gitEmail: environment?.gitEmail ?? "",
    sshKeyPath: environment?.sshKeyPath ?? "",
    accounts: environment?.accounts.map((account) => ({ provider: account.provider, values: account.values })) ?? [],
    claudeMode: environment?.claudeMode ?? "inherit",
    claudeApiKey: undefined,
    model: environment?.model ?? "",
    variables: environment?.variables ?? [],
    projectIds: environment?.projectIds ?? [],
  };
}

/** Any number of provider accounts; fields come from the provider catalog. */
function AccountsSection(props: {
  providers: EnvironmentProvider[];
  accounts: EnvironmentInput["accounts"];
  storedAccounts: Environment["accounts"];
  checks: EnvironmentAccountChecks;
  importing: boolean;
  importResult: { found: string[]; notFound: string[] } | null;
  onImport?: () => void;
  onChange: (accounts: EnvironmentInput["accounts"]) => void;
}) {
  const providerOf = (providerId: string) => props.providers.find((provider) => provider.id === providerId);
  const availableProviders = props.providers.filter((provider) => !props.accounts.some((account) => account.provider === provider.id));
  const setValue = (providerId: string, key: string, value: string) =>
    props.onChange(props.accounts.map((account) => (account.provider === providerId ? { ...account, values: { ...account.values, [key]: value } } : account)));

  return (
    <section className="grid gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">Konten</h3>
        <div className="ml-auto flex items-center gap-1">
          {props.onImport && (
            <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[12px] text-muted-foreground" disabled={props.importing} onClick={props.onImport}>
              {props.importing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Vom Rechner übernehmen
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[12px] text-muted-foreground" disabled={availableProviders.length === 0}>
                <Plus className="size-3.5" /> Konto
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-52 overflow-y-auto">
              {availableProviders.map((provider) => (
                <DropdownMenuItem key={provider.id} className="text-[13px]" onSelect={() => props.onChange([...props.accounts, { provider: provider.id, values: {} }])}>
                  {provider.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {props.importResult && (
        <p className="animate-in text-[12px] text-muted-foreground fade-in duration-150">
          Übernommen: {props.importResult.found.join(", ") || "nichts gefunden"}
        </p>
      )}

      {props.accounts.map((account) => {
        const provider = providerOf(account.provider);
        const storedKeys = props.storedAccounts.find((stored) => stored.provider === account.provider)?.setKeys ?? [];
        const check = props.checks[account.provider];
        return (
          <div key={account.provider} className="grid animate-in gap-2.5 rounded-xl border p-3 fade-in duration-150">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{provider?.label ?? account.provider}</span>
              {check && (
                <span className={`flex items-center gap-1 text-[12px] ${check.ok ? "text-status-running" : "text-destructive"}`}>
                  {check.ok ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                  {check.detail}
                </span>
              )}
              <button
                type="button"
                className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => props.onChange(props.accounts.filter((candidate) => candidate.provider !== account.provider))}
                aria-label="Konto entfernen"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(provider?.fields ?? Object.keys(account.values).map((key) => ({ key, label: key, secret: true, placeholder: undefined }))).map((providerField) => (
                <FormField key={providerField.key} label={providerField.label} htmlFor={`${account.provider}-${providerField.key}`}>
                  <Input
                    id={`${account.provider}-${providerField.key}`}
                    type={providerField.secret ? "password" : "text"}
                    autoComplete="off"
                    className="font-mono text-[12.5px]"
                    title={providerField.key}
                    value={account.values[providerField.key] ?? ""}
                    placeholder={providerField.secret && storedKeys.includes(providerField.key) ? "gespeichert" : (providerField.placeholder ?? providerField.key)}
                    onChange={(changeEvent) => setValue(account.provider, providerField.key, changeEvent.target.value)}
                  />
                </FormField>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
