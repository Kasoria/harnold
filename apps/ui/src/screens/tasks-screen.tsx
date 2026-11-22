import { useEffect, useState } from "react";
import { ChevronRight, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { DetailPane, EmptyState, ListRow, MasterDetail, ScreenLayout } from "./screen-layout";
import { api } from "@/api";
import type { Channel, Project, Task, TaskInput, TaskRun, TeamAgent } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/status-dot";
import { FormField, formatRelativeTime, permissionModeOptions } from "@/components/form-field";
import { ModelSelect, type InheritedModel } from "@/components/model-select";
import { confirmAction } from "@/components/confirm-dialog";
import { t } from "@/lib/i18n";
import { Combobox } from "@/components/ui/combobox";
import { describeSchedule, ScheduleEditor } from "@/components/schedule-editor";
import { SavedCheck, useSavedFlash } from "@/components/save-feedback";
import { toast } from "@/lib/toast";

export { describeSchedule };

/** Run summaries are Markdown; the list shows them as plain text. */
const plainSummary = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

type TasksScreenProps = {
  inheritedModelFor: (projectId: string) => InheritedModel;
  teamForProject: (projectId: string) => TeamAgent[];
  selectedTaskId: string | "new" | null;
  onSelectTask: (taskId: string | "new" | null) => void;
  tasks: Task[];
  projects: Project[];
  channels: Channel[];
  defaultProjectId: string | null;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onError: (unknownError: unknown) => void;
};

function emptyTaskInput(projectId: string): TaskInput {
  return {
    projectId,
    name: "",
    prompt: "",
    schedule: "0 8 * * 1-5",
    enabled: true,
    permissionMode: "acceptEdits",
    model: null,
    agentId: null,
    sessionMode: "new",
    cleanupAfterDays: null,
    contextResetRuns: null,
    notifyChannelId: null,
    notifyChatId: null,
  };
}

function TaskEditor(props: {
  inheritedModelFor: (projectId: string) => InheritedModel;
  teamForProject: (projectId: string) => TeamAgent[];
  task: Task | null;
  initialInput: TaskInput;
  projects: Project[];
  channels: Channel[];
  /** Saved task id; null after deletion. */
  onSaved: (savedTaskId: string | null) => void;
  onCancel: () => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onError: (unknownError: unknown) => void;
}) {
  const [taskInput, setTaskInput] = useState<TaskInput>(props.initialInput);
  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([]);
  const [saving, setSaving] = useState(false);
  const { saved, flashSaved } = useSavedFlash();

  const updateInput = (changes: Partial<TaskInput>) => setTaskInput((previous) => ({ ...previous, ...changes }));
  const projectTeam = props.teamForProject(taskInput.projectId);
  // A member of another environment's team doesn't exist in the newly chosen project.
  useEffect(() => {
    if (taskInput.agentId && !projectTeam.some((agent) => agent.id === taskInput.agentId)) updateInput({ agentId: null });
  }, [taskInput.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (props.task) api.listTaskRuns(props.task.id).then(setTaskRuns).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.task?.id, props.task?.lastRun?.status]);

  const save = async () => {
    setSaving(true);
    try {
      const savedTask = props.task ? await api.updateTask(props.task.id, taskInput) : await api.createTask(taskInput);
      flashSaved();
      if (!props.task) toast.success(t("Task „{0}“ angelegt", savedTask.name));
      props.onSaved(savedTask.id);
    } catch (saveError) {
      props.onError(saveError);
    } finally {
      setSaving(false);
    }
  };

  const valid = taskInput.name.trim() && taskInput.prompt.trim() && taskInput.schedule.trim() && taskInput.projectId;

  return (
    <div className="grid gap-4 py-3">
      <FormField label={t("Name")}>
        <Input value={taskInput.name} placeholder={t("z. B. Morgen-Briefing")} onChange={(event) => updateInput({ name: event.target.value })} />
      </FormField>
      <FormField label={t("Projekt")}>
        <Combobox
          value={taskInput.projectId}
          placeholder={t("Projekt wählen")}
          options={props.projects.map((project) => ({ value: project.id, label: project.name }))}
          onValueChange={(projectId) => updateInput({ projectId })}
        />
      </FormField>
      <FormField label={t("Auftrag")}>
        <Textarea
          rows={4}
          value={taskInput.prompt}
          placeholder={t("Was soll der Agent tun?")}
          onChange={(event) => updateInput({ prompt: event.target.value })}
        />
      </FormField>
      <FormField label={t("Zeitplan")}>
        <ScheduleEditor value={taskInput.schedule} onChange={(schedule) => updateInput({ schedule })} />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t("Rechte")}>
          <Select value={taskInput.permissionMode} onValueChange={(value) => updateInput({ permissionMode: value as TaskInput["permissionMode"] })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {permissionModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={t("Modell")}>
          <ModelSelect className="w-full" value={taskInput.model ?? ""} onChange={(model) => updateInput({ model: model || null })} inherited={props.inheritedModelFor(taskInput.projectId)} />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t("Agent")}>
          <Combobox
            value={taskInput.agentId ?? "default"}
            options={[{ value: "default", label: t("Harnold (Standard)") }, ...projectTeam.map((agent) => ({ value: agent.id, label: agent.name, description: agent.role || undefined }))]}
            onValueChange={(value) => updateInput({ agentId: value === "default" ? null : value })}
          />
        </FormField>
        <FormField label={t("Session")}>
          <Select value={taskInput.sessionMode} onValueChange={(value) => updateInput({ sessionMode: value as TaskInput["sessionMode"] })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">{t("Neue Session je Lauf")}</SelectItem>
              <SelectItem value="continue">{t("Immer dieselbe Session")}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </div>
      {taskInput.sessionMode === "new" ? (
        <FormField label={t("Alte Läufe")} hint={t("Läufe erscheinen gesammelt unter dem Task, nicht einzeln in der Session-Liste.")}>
          <Select value={String(taskInput.cleanupAfterDays ?? "keep")} onValueChange={(value) => updateInput({ cleanupAfterDays: value === "keep" ? null : Number(value) })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keep">{t("Alle behalten")}</SelectItem>
              {[1, 7, 30, 90].map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {days === 1 ? t("Nach 1 Tag löschen") : t("Nach {0} Tagen löschen", days)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      ) : (
        <FormField label={t("Gedächtnis des Agents")} hint={t("Der Verlauf bleibt immer sichtbar – nur der Agent fängt danach ohne die alten Läufe an.")}>
          <Select value={String(taskInput.contextResetRuns ?? "all")} onValueChange={(value) => updateInput({ contextResetRuns: value === "all" ? null : Number(value) })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("Erinnert sich an alle Läufe")}</SelectItem>
              {[5, 10, 25, 50, 100].map((runs) => (
                <SelectItem key={runs} value={String(runs)}>
                  {t("Neu anfangen nach {0} Läufen", runs)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}
      <FormField label={t("Ergebnis zusätzlich senden an")}>
        <div className="flex gap-2">
          <Combobox
            className="w-44 shrink-0"
            value={taskInput.notifyChannelId ?? "none"}
            options={[{ value: "none", label: t("Nur in Harnold") }, ...props.channels.map((channel) => ({ value: channel.id, label: channel.name }))]}
            onValueChange={(value) => {
              const channel = props.channels.find((candidate) => candidate.id === value);
              updateInput({ notifyChannelId: channel?.id ?? null, notifyChatId: channel ? (taskInput.notifyChatId ?? channel.allowedSenders[0] ?? "") : null });
            }}
          />
          {taskInput.notifyChannelId && (
            <Input
              className="flex-1 animate-in fade-in duration-200"
              value={taskInput.notifyChatId ?? ""}
              placeholder={t("Chat-ID / Adresse")}
              onChange={(event) => updateInput({ notifyChatId: event.target.value })}
            />
          )}
        </div>
      </FormField>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!valid || saving} onClick={save}>
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {t("Speichern")}
          <SavedCheck saved={saved} />
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          {t("Abbrechen")}
        </Button>
        {props.task && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={async () => {
              if (!(await confirmAction({ title: t("Task „{0}“ löschen?", props.task!.name), description: t("Die bisherigen Läufe bleiben als Sessions erhalten.") }))) return;
              await api
                .deleteTask(props.task!.id)
                .then(() => toast.success(t("Task „{0}“ gelöscht", props.task!.name)))
                .catch(props.onError);
              props.onSaved(null);
            }}
          >
            <Trash2 className="size-3.5" /> {t("Löschen")}
          </Button>
        )}
      </div>

      {taskRuns.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1 border-t pt-3">
          <span className="text-[12px] font-medium">{t("Letzte Läufe")}</span>
          {taskRuns.slice(0, 20).map((taskRun) => (
            <button
              key={taskRun.id}
              disabled={!taskRun.sessionId}
              onClick={() => taskRun.sessionId && props.onOpenSession(taskInput.projectId, taskRun.sessionId)}
              className="flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-foreground/5"
            >
              <StatusDot className="mt-1.5" status={taskRun.status === "running" ? "running" : taskRun.status === "error" ? "error" : "idle"} />
              <span className="min-w-0 flex-1">
                <span className="block text-muted-foreground">{formatRelativeTime(taskRun.startedAt)}</span>
                <span className="line-clamp-2 break-words">{taskRun.summary ? plainSummary(taskRun.summary) : t("Läuft …")}</span>
              </span>
              <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TasksScreen(props: TasksScreenProps) {
  const defaultProjectId = props.defaultProjectId ?? props.projects[0]?.id ?? "";
  const selectedTask = props.tasks.find((task) => task.id === props.selectedTaskId) ?? null;
  const creatingTask = props.selectedTaskId === "new";

  const toggleEnabled = async (task: Task, enabled: boolean) => {
    const { id: _id, createdAt: _createdAt, nextRunAt: _nextRunAt, lastRun: _lastRun, ...taskInput } = task;
    await api.updateTask(task.id, { ...taskInput, enabled }).catch(props.onError);
  };

  const projectNameOf = (projectId: string) => props.projects.find((project) => project.id === projectId)?.name ?? "—";

  const detail = creatingTask ? (
    <DetailPane detailKey="new" title={t("Neuer Task")} subtitle={t("Geplanter Agent-Lauf. Jeder Lauf landet als Session im Projekt.")}>
      <TaskEditor
        task={null}
        initialInput={emptyTaskInput(defaultProjectId)}
        projects={props.projects}
        inheritedModelFor={props.inheritedModelFor}
        teamForProject={props.teamForProject}
        channels={props.channels}
        onSaved={(savedTaskId) => props.onSelectTask(savedTaskId ?? null)}
        onCancel={() => props.onSelectTask(null)}
        onOpenSession={props.onOpenSession}
        onError={props.onError}
      />
    </DetailPane>
  ) : selectedTask ? (
    <DetailPane
      detailKey={selectedTask.id}
      title={selectedTask.name}
      subtitle={`${describeSchedule(selectedTask.schedule)} · ${projectNameOf(selectedTask.projectId)}${
        selectedTask.nextRunAt ? t(" · nächster Lauf {0}", formatRelativeTime(selectedTask.nextRunAt)) : selectedTask.enabled ? "" : t(" · pausiert")
      }`}
      actions={
        <Button size="sm" variant="secondary" disabled={selectedTask.lastRun?.status === "running"} onClick={() => api.runTask(selectedTask.id).catch(props.onError)}>
          <Play className="size-3.5" /> {t("Jetzt ausführen")}
        </Button>
      }
    >
      <TaskEditor
        key={selectedTask.id}
        task={selectedTask}
        initialInput={{
          projectId: selectedTask.projectId,
          name: selectedTask.name,
          prompt: selectedTask.prompt,
          schedule: selectedTask.schedule,
          enabled: selectedTask.enabled,
          permissionMode: selectedTask.permissionMode,
          model: selectedTask.model,
          agentId: selectedTask.agentId,
          sessionMode: selectedTask.sessionMode,
          cleanupAfterDays: selectedTask.cleanupAfterDays,
          contextResetRuns: selectedTask.contextResetRuns,
          notifyChannelId: selectedTask.notifyChannelId,
          notifyChatId: selectedTask.notifyChatId,
        }}
        projects={props.projects}
        inheritedModelFor={props.inheritedModelFor}
        teamForProject={props.teamForProject}
        channels={props.channels}
        onSaved={(savedTaskId) => props.onSelectTask(savedTaskId === null ? null : selectedTask.id)}
        onCancel={() => props.onSelectTask(null)}
        onOpenSession={props.onOpenSession}
        onError={props.onError}
      />
    </DetailPane>
  ) : (
    <EmptyState
      title={props.tasks.length ? t("Task wählen") : t("Noch keine Tasks")}
      action={
        <Button size="sm" disabled={!props.projects.length} onClick={() => props.onSelectTask("new")}>
          <Plus className="size-3.5" /> {t("Neuer Task")}
        </Button>
      }
    />
  );

  return (
    <ScreenLayout
      title={t("Tasks")}
      actions={
        <Button size="sm" variant="secondary" disabled={!props.projects.length} onClick={() => props.onSelectTask("new")}>
          <Plus className="size-3.5" /> {t("Neuer Task")}
        </Button>
      }
    >
      <MasterDetail
        list={
          props.tasks.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">{t("Noch keine Tasks.")}</p>
          ) : (
            props.tasks.map((task) => (
              <ListRow
                key={task.id}
                selected={task.id === props.selectedTaskId}
                onSelect={() => props.onSelectTask(task.id)}
                leading={<Switch checked={task.enabled} onCheckedChange={(enabled) => void toggleEnabled(task, enabled)} aria-label={t("Aktiv")} />}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{task.name}</span>
                  {task.lastRun && <StatusDot status={task.lastRun.status === "running" ? "running" : task.lastRun.status === "error" ? "error" : "idle"} />}
                </div>
                <div className="truncate text-[11.5px] text-muted-foreground">
                  {describeSchedule(task.schedule)} · {projectNameOf(task.projectId)}
                </div>
              </ListRow>
            ))
          )
        }
        detail={detail}
      />
    </ScreenLayout>
  );
}
