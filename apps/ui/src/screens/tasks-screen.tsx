import { useEffect, useState } from "react";
import { ChevronRight, Play, Plus, Trash2 } from "lucide-react";
import { DetailPane, EmptyState, ListRow, MasterDetail, ScreenLayout } from "./screen-layout";
import { api } from "@/api";
import type { Channel, Project, Task, TaskInput, TaskRun } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/status-dot";
import { FormField, formatRelativeTime, permissionModeOptions } from "@/components/form-field";
import { ModelSelect, type InheritedModel } from "@/components/model-select";
import { confirmAction } from "@/components/confirm-dialog";

const schedulePresets = [
  { value: "0 * * * *", label: "Stündlich" },
  { value: "0 8 * * *", label: "Täglich 8:00" },
  { value: "0 8 * * 1-5", label: "Werktags 8:00" },
  { value: "0 8 * * 1", label: "Montags 8:00" },
];
const customScheduleValue = "custom";

export function describeSchedule(schedule: string): string {
  return schedulePresets.find((preset) => preset.value === schedule)?.label ?? schedule;
}

type TasksScreenProps = {
  inheritedModelFor: (projectId: string) => InheritedModel;
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
    notifyChannelId: null,
    notifyChatId: null,
  };
}

function TaskEditor(props: {
  inheritedModelFor: (projectId: string) => InheritedModel;
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
  const [customSchedule, setCustomSchedule] = useState(!schedulePresets.some((preset) => preset.value === props.initialInput.schedule));
  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([]);
  const [saving, setSaving] = useState(false);

  const updateInput = (changes: Partial<TaskInput>) => setTaskInput((previous) => ({ ...previous, ...changes }));

  useEffect(() => {
    if (props.task) api.listTaskRuns(props.task.id).then(setTaskRuns).catch(props.onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.task?.id, props.task?.lastRun?.status]);

  const save = async () => {
    setSaving(true);
    try {
      const savedTask = props.task ? await api.updateTask(props.task.id, taskInput) : await api.createTask(taskInput);
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
      <FormField label="Name">
        <Input value={taskInput.name} placeholder="z. B. Morgen-Briefing" onChange={(event) => updateInput({ name: event.target.value })} />
      </FormField>
      <FormField label="Projekt">
        <Select value={taskInput.projectId} onValueChange={(projectId) => updateInput({ projectId })}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Projekt wählen" />
          </SelectTrigger>
          <SelectContent>
            {props.projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField label="Auftrag">
        <Textarea
          rows={4}
          value={taskInput.prompt}
          placeholder="Was soll der Agent tun?"
          onChange={(event) => updateInput({ prompt: event.target.value })}
        />
      </FormField>
      <FormField label="Zeitplan" hint={customSchedule ? "Minute Stunde Tag Monat Wochentag" : undefined}>
        <div className="flex gap-2">
          <Select
            value={customSchedule ? customScheduleValue : taskInput.schedule}
            onValueChange={(value) => {
              if (value === customScheduleValue) setCustomSchedule(true);
              else {
                setCustomSchedule(false);
                updateInput({ schedule: value });
              }
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {schedulePresets.map((preset) => (
                <SelectItem key={preset.value} value={preset.value}>
                  {preset.label}
                </SelectItem>
              ))}
              <SelectItem value={customScheduleValue}>Eigener …</SelectItem>
            </SelectContent>
          </Select>
          {customSchedule && (
            <Input
              className="flex-1 animate-in font-mono fade-in duration-200"
              value={taskInput.schedule}
              placeholder="*/30 9-18 * * 1-5"
              onChange={(event) => updateInput({ schedule: event.target.value })}
            />
          )}
        </div>
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Rechte">
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
        <FormField label="Modell">
          <ModelSelect className="w-full" value={taskInput.model ?? ""} onChange={(model) => updateInput({ model: model || null })} inherited={props.inheritedModelFor(taskInput.projectId)} />
        </FormField>
      </div>
      <FormField label="Ergebnis zusätzlich senden an">
        <div className="flex gap-2">
          <Select
            value={taskInput.notifyChannelId ?? "none"}
            onValueChange={(value) => {
              const channel = props.channels.find((candidate) => candidate.id === value);
              updateInput({ notifyChannelId: channel?.id ?? null, notifyChatId: channel ? (taskInput.notifyChatId ?? channel.allowedSenders[0] ?? "") : null });
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nur in Harnold</SelectItem>
              {props.channels.map((channel) => (
                <SelectItem key={channel.id} value={channel.id}>
                  {channel.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {taskInput.notifyChannelId && (
            <Input
              className="flex-1 animate-in fade-in duration-200"
              value={taskInput.notifyChatId ?? ""}
              placeholder="Chat-ID / Adresse"
              onChange={(event) => updateInput({ notifyChatId: event.target.value })}
            />
          )}
        </div>
      </FormField>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!valid || saving} onClick={save}>
          Speichern
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Abbrechen
        </Button>
        {props.task && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={async () => {
              if (!(await confirmAction({ title: `Task „${props.task!.name}“ löschen?`, description: "Die bisherigen Läufe bleiben als Sessions erhalten." }))) return;
              await api.deleteTask(props.task!.id).catch(props.onError);
              props.onSaved(null);
            }}
          >
            <Trash2 className="size-3.5" /> Löschen
          </Button>
        )}
      </div>

      {taskRuns.length > 0 && (
        <div className="grid gap-1 border-t pt-3">
          <span className="text-[12px] font-medium">Letzte Läufe</span>
          {taskRuns.slice(0, 20).map((taskRun) => (
            <button
              key={taskRun.id}
              disabled={!taskRun.sessionId}
              onClick={() => taskRun.sessionId && props.onOpenSession(taskInput.projectId, taskRun.sessionId)}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] transition-colors hover:bg-foreground/5"
            >
              <StatusDot status={taskRun.status === "running" ? "running" : taskRun.status === "error" ? "error" : "idle"} />
              <span className="shrink-0 text-muted-foreground">{formatRelativeTime(taskRun.startedAt)}</span>
              <span className="truncate">{taskRun.summary ?? "Läuft …"}</span>
              <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
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
    <DetailPane detailKey="new" title="Neuer Task" subtitle="Geplanter Agent-Lauf. Jeder Lauf landet als Session im Projekt.">
      <TaskEditor
        task={null}
        initialInput={emptyTaskInput(defaultProjectId)}
        projects={props.projects}
        inheritedModelFor={props.inheritedModelFor}
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
        selectedTask.nextRunAt ? ` · nächster Lauf ${formatRelativeTime(selectedTask.nextRunAt)}` : selectedTask.enabled ? "" : " · pausiert"
      }`}
      actions={
        <Button size="sm" variant="secondary" disabled={selectedTask.lastRun?.status === "running"} onClick={() => api.runTask(selectedTask.id).catch(props.onError)}>
          <Play className="size-3.5" /> Jetzt ausführen
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
          notifyChannelId: selectedTask.notifyChannelId,
          notifyChatId: selectedTask.notifyChatId,
        }}
        projects={props.projects}
        inheritedModelFor={props.inheritedModelFor}
        channels={props.channels}
        onSaved={(savedTaskId) => props.onSelectTask(savedTaskId === null ? null : selectedTask.id)}
        onCancel={() => props.onSelectTask(null)}
        onOpenSession={props.onOpenSession}
        onError={props.onError}
      />
    </DetailPane>
  ) : (
    <EmptyState
      title={props.tasks.length ? "Task wählen" : "Noch keine Tasks"}
      action={
        <Button size="sm" disabled={!props.projects.length} onClick={() => props.onSelectTask("new")}>
          <Plus className="size-3.5" /> Neuer Task
        </Button>
      }
    />
  );

  return (
    <ScreenLayout
      title="Tasks"
      actions={
        <Button size="sm" variant="secondary" disabled={!props.projects.length} onClick={() => props.onSelectTask("new")}>
          <Plus className="size-3.5" /> Neuer Task
        </Button>
      }
    >
      <MasterDetail
        list={
          props.tasks.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">Noch keine Tasks.</p>
          ) : (
            props.tasks.map((task) => (
              <ListRow
                key={task.id}
                selected={task.id === props.selectedTaskId}
                onSelect={() => props.onSelectTask(task.id)}
                leading={<Switch checked={task.enabled} onCheckedChange={(enabled) => void toggleEnabled(task, enabled)} aria-label="Aktiv" />}
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
