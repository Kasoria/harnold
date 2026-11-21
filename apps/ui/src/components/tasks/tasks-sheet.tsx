import { useEffect, useState } from "react";
import { ChevronRight, Play, Plus, Trash2 } from "lucide-react";
import { api } from "@/api";
import type { Channel, Project, Task, TaskInput, TaskRun } from "@/types";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { StatusDot } from "@/components/status-dot";
import { FormField, formatRelativeTime, modelOptions, permissionModeOptions } from "@/components/form-field";

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

type TasksSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  task: Task | null;
  initialInput: TaskInput;
  projects: Project[];
  channels: Channel[];
  onSaved: () => void;
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
      if (props.task) await api.updateTask(props.task.id, taskInput);
      else await api.createTask(taskInput);
      props.onSaved();
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
      <FormField label="Zeitplan" hint={customSchedule ? "Cron-Ausdruck: Minute Stunde Tag Monat Wochentag (Server-Zeitzone)." : undefined}>
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
          <Select value={taskInput.model ?? "default"} onValueChange={(value) => updateInput({ model: value === "default" ? null : value })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <FormField label="Ergebnis senden an" hint="Das Ergebnis erscheint immer als Session im Projekt.">
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
              if (!window.confirm(`Task „${props.task!.name}“ löschen?`)) return;
              await api.deleteTask(props.task!.id).catch(props.onError);
              props.onSaved();
            }}
          >
            <Trash2 className="size-3.5" /> Löschen
          </Button>
        )}
      </div>

      {taskRuns.length > 0 && (
        <div className="grid gap-1 border-t pt-3">
          <span className="text-[12px] font-medium">Letzte Läufe</span>
          {taskRuns.slice(0, 6).map((taskRun) => (
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

export function TasksSheet(props: TasksSheetProps) {
  const [editingTaskId, setEditingTaskId] = useState<string | "new" | null>(null);

  useEffect(() => {
    if (!props.open) setEditingTaskId(null);
  }, [props.open]);

  const toggleEnabled = async (task: Task, enabled: boolean) => {
    const { id: _id, createdAt: _createdAt, nextRunAt: _nextRunAt, lastRun: _lastRun, ...taskInput } = task;
    await api.updateTask(task.id, { ...taskInput, enabled }).catch(props.onError);
  };

  const defaultProjectId = props.defaultProjectId ?? props.projects[0]?.id ?? "";

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-[520px]">
        <SheetHeader className="border-b">
          <SheetTitle>Tasks</SheetTitle>
          <SheetDescription>Geplante Agent-Läufe. Jeder Lauf landet als Session im Projekt.</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <Collapsible open={editingTaskId === "new"}>
            {editingTaskId !== "new" && (
              <Button size="sm" variant="secondary" className="mb-2" disabled={!props.projects.length} onClick={() => setEditingTaskId("new")}>
                <Plus className="size-3.5" /> Neuer Task
              </Button>
            )}
            <CollapsibleContent className="collapsible-animated">
              <div className="mb-3 rounded-xl border bg-card px-4">
                  <TaskEditor
                    task={null}
                    initialInput={emptyTaskInput(defaultProjectId)}
                    projects={props.projects}
                    channels={props.channels}
                    onSaved={() => setEditingTaskId(null)}
                    onCancel={() => setEditingTaskId(null)}
                    onOpenSession={props.onOpenSession}
                    onError={props.onError}
                  />
                </div>
            </CollapsibleContent>
          </Collapsible>

          {props.tasks.length === 0 && editingTaskId !== "new" && (
            <p className="py-6 text-center text-[13px] text-muted-foreground">Noch keine Tasks.</p>
          )}

          <ul className="grid gap-1.5">
            {props.tasks.map((task) => {
              const expanded = editingTaskId === task.id;
              const projectName = props.projects.find((project) => project.id === task.projectId)?.name ?? "—";
              return (
                <li key={task.id} className={cn("rounded-xl border transition-colors duration-200", expanded ? "bg-card" : "border-transparent hover:bg-foreground/[0.03]")}>
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <Switch checked={task.enabled} onCheckedChange={(enabled) => void toggleEnabled(task, enabled)} aria-label="Aktiv" />
                    <button className="min-w-0 flex-1 text-left" onClick={() => setEditingTaskId(expanded ? null : task.id)}>
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] font-medium">{task.name}</span>
                        {task.lastRun && (
                          <StatusDot status={task.lastRun.status === "running" ? "running" : task.lastRun.status === "error" ? "error" : "idle"} />
                        )}
                      </div>
                      <div className="truncate text-[12px] text-muted-foreground">
                        {describeSchedule(task.schedule)} · {projectName}
                        {task.nextRunAt ? ` · nächster Lauf ${formatRelativeTime(task.nextRunAt)}` : task.enabled ? "" : " · pausiert"}
                      </div>
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground"
                      aria-label="Jetzt ausführen"
                      title="Jetzt ausführen"
                      disabled={task.lastRun?.status === "running"}
                      onClick={() => api.runTask(task.id).catch(props.onError)}
                    >
                      <Play className="size-3.5" />
                    </Button>
                  </div>
                  <Collapsible open={expanded}>
                    <CollapsibleContent className="collapsible-animated">
                        <div className="border-t px-4">
                          <TaskEditor
                            task={task}
                            initialInput={{
                              projectId: task.projectId,
                              name: task.name,
                              prompt: task.prompt,
                              schedule: task.schedule,
                              enabled: task.enabled,
                              permissionMode: task.permissionMode,
                              model: task.model,
                              notifyChannelId: task.notifyChannelId,
                              notifyChatId: task.notifyChatId,
                            }}
                            projects={props.projects}
                            channels={props.channels}
                            onSaved={() => setEditingTaskId(null)}
                            onCancel={() => setEditingTaskId(null)}
                            onOpenSession={props.onOpenSession}
                            onError={props.onError}
                          />
                        </div>
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              );
            })}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}
