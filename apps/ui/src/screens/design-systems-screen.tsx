import { useEffect, useState } from "react";
import { FolderOpen, Link2, Loader2, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { api } from "@/api";
import type { DesignSystemDetail, DesignSystemLinkTarget, DesignSystemSummary, Project, Session } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/segmented-control";
import { OptionSelect } from "@/components/option-select";
import { FormField, formatRelativeTime } from "@/components/form-field";
import { DesignTokensEditor } from "@/components/design-system/design-tokens-editor";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";
import { toast } from "@/lib/toast";
import { DetailPane, EmptyState, ListRow, MasterDetail, ScreenLayout } from "./screen-layout";
import { confirmAction } from "@/components/confirm-dialog";
import { isActionEnter } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Combobox } from "@/components/ui/combobox";

type DesignSystemsScreenProps = {
  /** Selected system id, "new" for the create form, null for none. */
  selection: string | null;
  onSelect: (selection: string | null) => void;
  projects: Project[];
  sessionsByProjectId: Record<string, Session[]>;
  designSystemsChangeCounter: number;
  /** Opens the linked session (or a new session in the linked project) and sends or pre-fills the prompt. */
  onWorkWithAgent: (target: DesignSystemLinkTarget, prompt: string, sendImmediately: boolean) => void;
  onError: (unknownError: unknown) => void;
};

type CreationTemplate = "starter" | "derive" | "empty";

const sameTarget = (first: DesignSystemLinkTarget, second: DesignSystemLinkTarget) => first.targetType === second.targetType && first.targetId === second.targetId;

const derivePrompt = (designSystem: DesignSystemDetail) =>
  t(
    "Analysiere das Projekt (Code, Styles, Entwürfe unter design/) und fülle das verknüpfte Design System „{0}“ unter {1}: tokens.json (Farben, Typografie, Abstände, Radien, Schatten; $modes.dark falls sinnvoll) und Referenz-Komponenten unter components/*.html, die ../tokens.css einbinden. Passe danach vorhandene Entwürfe an die Tokens an.",
    designSystem.name,
    designSystem.directory,
  );

function Swatches(props: { colors: string[] }) {
  if (props.colors.length === 0) return <div className="size-8 rounded-lg border bg-muted" />;
  return (
    <div className="grid size-8 grid-cols-3 grid-rows-2 overflow-hidden rounded-lg border">
      {props.colors.slice(0, 6).map((color, colorIndex) => (
        <span key={colorIndex} style={{ background: color }} />
      ))}
    </div>
  );
}

export function DesignSystemsScreen(props: DesignSystemsScreenProps) {
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const { onError } = props;

  useEffect(() => {
    api.listDesignSystems().then(setDesignSystems).catch(onError);
  }, [props.designSystemsChangeCounter, onError]);

  const selectedId = props.selection && props.selection !== "new" ? props.selection : null;

  return (
    <ScreenLayout
      title={t("Design Systems")}
      actions={
        <Button size="sm" className="gap-1.5" onClick={() => props.onSelect("new")}>
          <Plus className="size-3.5" /> {t("Neues Design System")}
        </Button>
      }
    >
      <MasterDetail
        list={
          designSystems.length === 0 ? (
            <p className="p-3 text-[12.5px] text-muted-foreground">{t("Noch keine Design Systems.")}</p>
          ) : (
            designSystems.map((designSystem) => (
              <ListRow
                key={designSystem.id}
                selected={designSystem.id === selectedId}
                onSelect={() => props.onSelect(designSystem.id)}
                leading={<Swatches colors={designSystem.swatches} />}
              >
                <div className="truncate text-[13px] font-medium">{designSystem.name}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {designSystem.tokenCount} {t("Tokens ·")} {designSystem.links.length === 0 ? t("nicht verknüpft") : t("{0} verknüpft", designSystem.links.length)}
                </div>
              </ListRow>
            ))
          )
        }
        detail={
          props.selection === "new" ? (
            <CreateDesignSystemForm
              projects={props.projects}
              onCreated={(createdSystem, template) => {
                setDesignSystems((previous) => [{ ...createdSystem, createdAt: Date.now(), updatedAt: Date.now(), tokenCount: createdSystem.flatTokens.length, swatches: [] }, ...previous]);
                props.onSelect(createdSystem.id);
                if (template === "derive" && createdSystem.links[0]) props.onWorkWithAgent(createdSystem.links[0], derivePrompt(createdSystem), true);
              }}
              onCancel={() => props.onSelect(null)}
              onError={onError}
            />
          ) : selectedId ? (
            <DesignSystemDetailView
              key={selectedId}
              designSystemId={selectedId}
              allDesignSystems={designSystems}
              projects={props.projects}
              sessionsByProjectId={props.sessionsByProjectId}
              designSystemsChangeCounter={props.designSystemsChangeCounter}
              onChanged={(changedSystem) =>
                setDesignSystems((previous) =>
                  previous.map((summary) =>
                    summary.id === changedSystem.id
                      ? { ...summary, name: changedSystem.name, links: changedSystem.links, tokenCount: changedSystem.flatTokens.length }
                      : // a target linked here moves away from other systems
                        { ...summary, links: summary.links.filter((link) => !changedSystem.links.some((changedLink) => sameTarget(link, changedLink))) },
                  ),
                )
              }
              onDeleted={() => {
                setDesignSystems((previous) => previous.filter((summary) => summary.id !== selectedId));
                props.onSelect(null);
              }}
              onWorkWithAgent={props.onWorkWithAgent}
              onError={onError}
            />
          ) : (
            <EmptyState
              title={designSystems.length ? t("Design System auswählen") : t("Noch kein Design System")}
              description={t("Tokens und Komponenten für Entwürfe und Code.")}
              action={
                <Button size="sm" onClick={() => props.onSelect("new")}>
                  <Plus className="size-3.5" /> {t("Neues Design System")}
                </Button>
              }
            />
          )
        }
      />
    </ScreenLayout>
  );
}

function CreateDesignSystemForm(props: {
  projects: Project[];
  onCreated: (createdSystem: DesignSystemDetail, template: CreationTemplate) => void;
  onCancel: () => void;
  onError: (unknownError: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<CreationTemplate>("starter");
  const [projectId, setProjectId] = useState<string>("none");
  const [creating, setCreating] = useState(false);
  const projectRequired = template === "derive";
  const canCreate = name.trim() && (!projectRequired || projectId !== "none") && !creating;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const links: DesignSystemLinkTarget[] = projectId !== "none" ? [{ targetType: "project", targetId: projectId }] : [];
      const createdSystem = await api.createDesignSystem(name.trim(), template === "starter" ? "starter" : "empty", links);
      toast.success(t("Design System „{0}“ angelegt", createdSystem.name));
      props.onCreated(createdSystem, template);
    } catch (createError) {
      props.onError(createError);
      setCreating(false);
    }
  };

  return (
    <DetailPane detailKey="new" title={t("Neues Design System")}>
      <form
        className="grid max-w-md gap-4"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          void create();
        }}
      >
        <FormField label={t("Name")} htmlFor="design-system-name">
          <Input id="design-system-name" autoFocus value={name} placeholder={t("z. B. Kasoria Marke")} onChange={(changeEvent) => setName(changeEvent.target.value)} />
        </FormField>
        <FormField label={t("Start")}>
          <OptionSelect
            className="w-full"
            options={[
              { value: "starter", label: t("Vorlage") },
              { value: "derive", label: t("Aus Projekt ableiten") },
              { value: "empty", label: t("Leer") },
            ]}
            value={template}
            onValueChange={setTemplate}
          />
        </FormField>
        <FormField label={projectRequired ? t("Projekt") : t("Verknüpfen mit")}>
          <Combobox
            value={projectId}
            options={[{ value: "none", label: projectRequired ? t("Projekt wählen …") : t("Nichts") }, ...props.projects.map((project) => ({ value: project.id, label: project.name }))]}
            onValueChange={setProjectId}
          />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={!canCreate}>
            {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {t("Anlegen")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={props.onCancel}>
            {t("Abbrechen")}
          </Button>
        </div>
      </form>
    </DetailPane>
  );
}

function DesignSystemDetailView(props: {
  designSystemId: string;
  allDesignSystems: DesignSystemSummary[];
  projects: Project[];
  sessionsByProjectId: Record<string, Session[]>;
  designSystemsChangeCounter: number;
  onChanged: (changedSystem: DesignSystemDetail) => void;
  onDeleted: () => void;
  onWorkWithAgent: DesignSystemsScreenProps["onWorkWithAgent"];
  onError: (unknownError: unknown) => void;
}) {
  const [designSystem, setDesignSystem] = useState<DesignSystemDetail | null>(null);
  const [mode, setMode] = useState<"base" | "dark">("base");
  const [nameDraft, setNameDraft] = useState("");
  const { designSystemId, onError } = props;

  useEffect(() => {
    api
      .readDesignSystem(designSystemId)
      .then((loadedSystem) => {
        setDesignSystem(loadedSystem);
        setNameDraft(loadedSystem.name);
      })
      .catch(onError);
  }, [designSystemId, props.designSystemsChangeCounter, onError]);

  if (!designSystem) return <div className="h-full" />;

  const { saved, flashSaved } = useSavedFlash();

  const applyChange = (changedSystem: DesignSystemDetail) => {
    setDesignSystem(changedSystem);
    props.onChanged(changedSystem);
  };

  const rename = () => {
    const trimmedName = nameDraft.trim();
    if (!trimmedName || trimmedName === designSystem.name) return setNameDraft(designSystem.name);
    api.renameDesignSystem(designSystem.id, trimmedName).then(applyChange).catch(onError);
  };

  const saveLinks = (links: DesignSystemLinkTarget[]) =>
    api
      .setDesignSystemLinks(designSystem.id, links)
      .then((savedSystem) => {
        applyChange(savedSystem);
        flashSaved();
      })
      .catch(onError);

  const remove = async () => {
    const linkHint = designSystem.links.length ? t(" Verknüpft mit {0} Projekten/Sessions.", designSystem.links.length) : "";
    if (!(await confirmAction({ title: t("Design System „{0}“ löschen?", designSystem.name), description: t("Alle Dateien werden entfernt.{0}", linkHint) }))) return;
    api
      .deleteDesignSystem(designSystem.id)
      .then(() => {
        toast.success(t("Design System „{0}“ gelöscht", designSystem.name));
        props.onDeleted();
      })
      .catch(onError);
  };

  const agentTarget = designSystem.links[0] ?? null;

  return (
    <div className="mx-auto max-w-4xl animate-in px-6 py-5 fade-in duration-200">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={nameDraft}
          aria-label={t("Name")}
          onChange={(changeEvent) => setNameDraft(changeEvent.target.value)}
          onBlur={rename}
          onKeyDown={(keyboardEvent) => {
            if (isActionEnter(keyboardEvent)) (keyboardEvent.target as HTMLInputElement).blur();
            if (keyboardEvent.key === "Escape") setNameDraft(designSystem.name);
          }}
          className="-ml-1.5 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[15px] font-semibold transition-colors duration-150 outline-none hover:border-border focus:border-ring"
        />
        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {designSystem.flatTokens.length} {t("Tokens · geändert")} {formatRelativeTime(props.allDesignSystems.find((summary) => summary.id === designSystem.id)?.updatedAt ?? Date.now())}
          <SavedCheck saved={saved} />
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {designSystem.modeTokens.dark && (
            <SegmentedControl
              className="w-36"
              options={[
                { value: "base", label: t("Hell") },
                { value: "dark", label: t("Dunkel") },
              ]}
              value={mode}
              onValueChange={setMode}
            />
          )}
          <Button
            size="sm"
            variant="secondary"
            className="h-7 gap-1.5 px-2 text-[12px]"
            disabled={!agentTarget}
            title={agentTarget ? undefined : t("Zuerst mit einem Projekt oder einer Session verknüpfen")}
            onClick={() => agentTarget && props.onWorkWithAgent(agentTarget, t("Design System „{0}“ ({1}): ", designSystem.name, designSystem.directory), false)}
          >
            <Wand2 className="size-3.5" /> {t("Mit Agent bearbeiten")}
          </Button>
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" title={designSystem.directory} onClick={() => void navigator.clipboard.writeText(designSystem.directory)} aria-label={t("Ordnerpfad kopieren")}>
            <FolderOpen className="size-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={remove} aria-label={t("Löschen")}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <LinksSection
        links={designSystem.links}
        designSystemId={designSystem.id}
        allDesignSystems={props.allDesignSystems}
        projects={props.projects}
        sessionsByProjectId={props.sessionsByProjectId}
        onChange={saveLinks}
      />

      {designSystem.flatTokens.length === 0 && designSystem.components.length === 0 ? (
        <EmptyState
          title={t("Noch leer")}
          description={t("tokens.json füllen oder aus einem Projekt ableiten.")}
          action={
            agentTarget && (
              <Button size="sm" variant="secondary" onClick={() => props.onWorkWithAgent(agentTarget, derivePrompt(designSystem), true)}>
                <Wand2 className="size-3.5" /> {t("Aus Projekt ableiten")}
              </Button>
            )
          }
        />
      ) : (
        <DesignTokensEditor designSystem={designSystem} mode={mode} reloadCounter={props.designSystemsChangeCounter} onSaved={applyChange} onError={onError} />
      )}
    </div>
  );
}

function LinksSection(props: {
  links: DesignSystemLinkTarget[];
  designSystemId: string;
  allDesignSystems: DesignSystemSummary[];
  projects: Project[];
  sessionsByProjectId: Record<string, Session[]>;
  onChange: (links: DesignSystemLinkTarget[]) => void;
}) {
  const projectName = (projectId: string) => props.projects.find((project) => project.id === projectId)?.name ?? "Projekt";
  const findSession = (sessionId: string) =>
    Object.entries(props.sessionsByProjectId).flatMap(([projectId, sessions]) => sessions.filter((session) => session.id === sessionId).map((session) => ({ session, projectId })))[0];

  const labelOf = (link: DesignSystemLinkTarget) => {
    if (link.targetType === "project") return projectName(link.targetId);
    const found = findSession(link.targetId);
    return found ? `${found.session.title} · ${projectName(found.projectId)}` : "Session";
  };

  /** Name of another system this target is currently linked to (linking here moves it). */
  const linkedElsewhere = (target: DesignSystemLinkTarget) =>
    props.allDesignSystems.find((summary) => summary.id !== props.designSystemId && summary.links.some((link) => sameTarget(link, target)))?.name;

  const isLinked = (target: DesignSystemLinkTarget) => props.links.some((link) => sameTarget(link, target));
  const toggle = (target: DesignSystemLinkTarget) => props.onChange(isLinked(target) ? props.links.filter((link) => !sameTarget(link, target)) : [...props.links, target]);

  const renderOption = (target: DesignSystemLinkTarget, label: string, indented: boolean) => {
    const otherSystemName = linkedElsewhere(target);
    return (
      <DropdownMenuCheckboxItem
        key={`${target.targetType}:${target.targetId}`}
        checked={isLinked(target)}
        onSelect={(selectEvent) => selectEvent.preventDefault()}
        onCheckedChange={() => toggle(target)}
        className={indented ? "pl-12 text-[12.5px]" : "text-[13px]"}
      >
        <span className="truncate">{label}</span>
        {otherSystemName && <span className="ml-auto shrink-0 pl-3 text-[11px] text-muted-foreground">{otherSystemName}</span>}
      </DropdownMenuCheckboxItem>
    );
  };

  return (
    <section className="mt-4 mb-6 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[12px] text-muted-foreground">{t("Verknüpft mit")}</span>
      {props.links.map((link) => (
        <span key={`${link.targetType}:${link.targetId}`} className="inline-flex animate-in items-center gap-1 rounded-md border bg-background py-0.5 pr-1 pl-2 text-[12px] fade-in duration-150">
          <span className="text-muted-foreground">{link.targetType === "project" ? t("Projekt") : t("Session")}</span>
          <span className="max-w-56 truncate">{labelOf(link)}</span>
          <button className="rounded text-muted-foreground transition-colors hover:text-foreground" onClick={() => toggle(link)} aria-label={t("Verknüpfung entfernen")}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[12px] text-muted-foreground">
            <Link2 className="size-3.5" /> {t("Verknüpfen")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-96 w-80 overflow-y-auto">
          <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">{t("Session-Verknüpfung geht vor Projekt. Rechts: aktuell verknüpftes System.")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {props.projects.length === 0 && <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground">{t("Keine Projekte.")}</p>}
          {props.projects.map((project) => [
            renderOption({ targetType: "project", targetId: project.id }, project.name, false),
            ...(props.sessionsByProjectId[project.id] ?? []).map((session) => renderOption({ targetType: "session", targetId: session.id }, session.title, true)),
          ])}
        </DropdownMenuContent>
      </DropdownMenu>
    </section>
  );
}
