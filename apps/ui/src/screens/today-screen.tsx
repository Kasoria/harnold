import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, CircleAlert, Loader2, MessageCircleQuestion, MessageSquare, ShieldAlert, Trash2 } from "lucide-react";
import { isQuestionRequest, questionsOf } from "@/components/chat/question-card";
import { api } from "@/api";
import type { Environment, PermissionRequest, Project, SessionReference, TodayOverview } from "@/types";
import { Button } from "@/components/ui/button";
import { ProjectAvatar } from "@/components/project-avatar";
import { formatRelativeTime } from "@/components/form-field";
import { summarizeToolInput } from "@/components/chat/tool-group";
import { InlineMarkdown } from "@/components/inline-markdown";
import { locale, t } from "@/lib/i18n";

type TodayScreenProps = {
  projects: Project[];
  environments: Environment[];
  /** Live from the event stream; the rest is loaded. */
  permissionRequests: PermissionRequest[];
  runningSessionIds: Set<string>;
  sessionReferenceFor: (sessionId: string) => SessionReference | null;
  /** Bumped on task runs and session changes. */
  reloadCounter: number;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onAnswerPermission: (requestId: string, allow: boolean, answers?: Record<string, string>) => void;
  onError: (unknownError: unknown) => void;
};

function Section(props: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 animate-in fade-in duration-200">
      <h2 className="mb-2 flex items-center gap-1.5 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{props.title}</h2>
      <div className="divide-y rounded-xl border bg-card">{props.children}</div>
    </section>
  );
}

function SessionRow(props: {
  reference: SessionReference;
  /** Icon of the referenced project, as configured in the sidebar. */
  projectIcon?: string | null;
  showProject?: boolean;
  leading: React.ReactNode;
  meta?: React.ReactNode;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
  /** Shown as a trash button on hover (e.g. to clear a task result). */
  onRemove?: () => void;
  removeLabel?: string;
  onOpen: () => void;
}) {
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5">
      <div className="shrink-0">{props.leading}</div>
      <button className="min-w-0 flex-1 text-left" onClick={props.onOpen}>
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{props.reference.sessionTitle}</span>
          {props.showProject !== false && (
            <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground">
              <ProjectAvatar name={props.reference.projectName} icon={props.projectIcon} className="size-3.5 rounded text-[8px]" />
              {props.reference.projectName}
            </span>
          )}
          {props.meta && <span className="ml-auto shrink-0 text-[12px] text-muted-foreground tabular-nums">{props.meta}</span>}
        </div>
        {props.detail && <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{props.detail}</div>}
      </button>
      {props.actions ?? (
        <div className="flex shrink-0 items-center gap-0.5">
          {props.onRemove && (
            <button
              type="button"
              aria-label={props.removeLabel ?? t("Entfernen")}
              title={props.removeLabel ?? t("Entfernen")}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-foreground/5 hover:text-destructive focus-visible:opacity-100"
              onClick={props.onRemove}
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      )}
    </div>
  );
}

/** Start screen: only what needs attention – approvals, running work, fresh task results – plus where to continue. */
export function TodayScreen(props: TodayScreenProps) {
  const [overview, setOverview] = useState<TodayOverview | null>(null);
  const { onError, reloadCounter } = props;

  useEffect(() => {
    api.readToday().then(setOverview).catch(onError);
  }, [reloadCounter, onError]);

  const waiting = props.permissionRequests.flatMap((permissionRequest) => {
    const reference = props.sessionReferenceFor(permissionRequest.sessionId);
    return reference ? [{ permissionRequest, reference }] : [];
  });
  const running = [...props.runningSessionIds].flatMap((sessionId) => {
    const reference = props.sessionReferenceFor(sessionId);
    return reference && !waiting.some((entry) => entry.reference.sessionId === sessionId) ? [reference] : [];
  });
  const taskResults = overview?.taskResults ?? [];
  const recentChats = overview?.recentSessions ?? [];
  const nothingPending = waiting.length === 0 && running.length === 0 && taskResults.length === 0;

  // Task results and chats, split by environment; projects without one form their own group.
  type Group = { key: string; name: string; icon: string | null; latest: number; taskRuns: typeof taskResults; chats: typeof recentChats };
  const groups = new Map<string, Group>();
  const groupFor = (projectId: string, projectName: string): Group => {
    const environment = props.environments.find((candidate) => candidate.projectIds.includes(projectId));
    const key = environment ? `environment:${environment.id}` : `project:${projectId}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, name: environment?.name ?? projectName, icon: environment?.icon ?? props.projects.find((project) => project.id === projectId)?.icon ?? null, latest: 0, taskRuns: [], chats: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const taskRun of taskResults) {
    if (!taskRun.session) continue;
    const group = groupFor(taskRun.session.projectId, taskRun.session.projectName);
    group.taskRuns.push(taskRun);
    group.latest = Math.max(group.latest, (taskRun.finishedAt ?? taskRun.startedAt));
  }
  for (const chat of recentChats) {
    const group = groupFor(chat.projectId, chat.projectName);
    group.chats.push(chat);
    group.latest = Math.max(group.latest, chat.updatedAt);
  }
  const orderedGroups = [...groups.values()].sort((first, second) => second.latest - first.latest);
  const open = (reference: SessionReference) => props.onOpenSession(reference.projectId, reference.sessionId);
  // Removing a result also removes its run session – so it disappears here for good.
  const removeTaskRun = (taskRunId: string) => {
    setOverview((previous) => previous && { ...previous, taskResults: previous.taskResults.filter((taskRun) => taskRun.id !== taskRunId) });
    api.deleteTaskRun(taskRunId).catch(onError);
  };
  const projectIconFor = (projectId: string) => props.projects.find((project) => project.id === projectId)?.icon ?? null;

  return (
    <section className="h-full overflow-y-auto bg-background">
      <div className="mx-auto grid w-full max-w-2xl min-w-0 animate-in grid-cols-[minmax(0,1fr)] gap-8 px-6 py-10 fade-in duration-200">
        <header>
          <h1 className="text-[20px] font-semibold">{t("Heute")}</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {new Date().toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" })}
            {overview && nothingPending && t(" · Nichts wartet auf dich.")}
          </p>
        </header>

        {waiting.length > 0 && (
          <Section title={t("Wartet auf dich")}>
            {waiting.map(({ permissionRequest, reference }) => (
              <SessionRow
                key={permissionRequest.requestId}
                reference={reference}
                projectIcon={projectIconFor(reference.projectId)}
                leading={
                  isQuestionRequest(permissionRequest.toolName) ? <MessageCircleQuestion className="size-4 text-status-waiting" /> : <ShieldAlert className="size-4 text-status-waiting" />
                }
                detail={
                  isQuestionRequest(permissionRequest.toolName)
                    ? t("Frage: {0}", questionsOf(permissionRequest.input).map((question) => question.question).join(" · "))
                    : `${permissionRequest.toolName}: ${summarizeToolInput(permissionRequest.input) || JSON.stringify(permissionRequest.input).slice(0, 120)}`
                }
                onOpen={() => open(reference)}
                actions={
                  isQuestionRequest(permissionRequest.toolName) ? (
                    <Button size="sm" className="h-7 shrink-0" onClick={() => open(reference)}>
                      {t("Beantworten")}
                    </Button>
                  ) : (
                  <div className="flex shrink-0 gap-1.5">
                    <Button size="sm" className="h-7" onClick={() => props.onAnswerPermission(permissionRequest.requestId, true)}>
                      {t("Erlauben")}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7" onClick={() => props.onAnswerPermission(permissionRequest.requestId, false)}>
                      {t("Ablehnen")}
                    </Button>
                  </div>
                  )
                }
              />
            ))}
          </Section>
        )}

        {running.length > 0 && (
          <Section title={t("Läuft")}>
            {running.map((reference) => (
              <SessionRow key={reference.sessionId} reference={reference} projectIcon={projectIconFor(reference.projectId)} leading={<Loader2 className="size-4 animate-spin text-status-running" />} onOpen={() => open(reference)} />
            ))}
          </Section>
        )}

        {orderedGroups.map((group) => {
          const projectCount = new Set([...group.taskRuns.map((taskRun) => taskRun.session!.projectId), ...group.chats.map((chat) => chat.projectId)]).size;
          const showProject = projectCount > 1;
          const sublabel = (label: string) => <div className="px-3 pt-2.5 pb-1 text-[11px] text-muted-foreground">{label}</div>;
          return (
            <Section
              key={group.key}
              title={
                <>
                  <ProjectAvatar name={group.name} icon={group.icon} className="size-4 rounded text-[9px]" />
                  {group.name}
                </>
              }
            >
              {group.taskRuns.length > 0 && (
                <div>
                  {sublabel(t("Task-Ergebnisse"))}
                  <div className="divide-y">
                    {group.taskRuns.map((taskRun) => (
                      <SessionRow
                        key={taskRun.id}
                        reference={{ ...taskRun.session!, sessionTitle: taskRun.taskName }}
                        projectIcon={projectIconFor(taskRun.session!.projectId)}
                        showProject={showProject}
                        leading={taskRun.status === "success" ? <CheckCircle2 className="size-4 text-status-running" /> : <CircleAlert className="size-4 text-destructive" />}
                        meta={formatRelativeTime(taskRun.finishedAt ?? taskRun.startedAt)}
                        detail={taskRun.summary ? <InlineMarkdown text={taskRun.summary} /> : undefined}
                        onRemove={() => removeTaskRun(taskRun.id)}
                        removeLabel={t("Ergebnis entfernen")}
                        onOpen={() => open(taskRun.session!)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {group.chats.length > 0 && (
                <div>
                  {sublabel(t("Weitermachen"))}
                  <div className="divide-y">
                    {group.chats.map((reference) => (
                      <SessionRow
                        key={reference.sessionId}
                        reference={reference}
                        projectIcon={projectIconFor(reference.projectId)}
                        showProject={showProject}
                        leading={<MessageSquare className="size-4 text-muted-foreground" />}
                        meta={formatRelativeTime(reference.updatedAt)}
                        onOpen={() => open(reference)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </Section>
          );
        })}
      </div>
    </section>
  );
}
