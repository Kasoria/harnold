import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, CircleAlert, Loader2, MessageCircleQuestion, MessageSquare, ShieldAlert } from "lucide-react";
import { isQuestionRequest, questionsOf } from "@/components/chat/question-card";
import { api } from "@/api";
import type { PermissionRequest, SessionReference, TodayOverview } from "@/types";
import { Button } from "@/components/ui/button";
import { ProjectAvatar } from "@/components/project-avatar";
import { formatRelativeTime } from "@/components/form-field";
import { summarizeToolInput } from "@/components/chat/tool-group";

type TodayScreenProps = {
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

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 animate-in fade-in duration-200">
      <h2 className="mb-2 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{props.title}</h2>
      <div className="divide-y rounded-xl border bg-card">{props.children}</div>
    </section>
  );
}

function SessionRow(props: { reference: SessionReference; leading: React.ReactNode; meta?: React.ReactNode; detail?: string; actions?: React.ReactNode; onOpen: () => void }) {
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5">
      <div className="shrink-0">{props.leading}</div>
      <button className="min-w-0 flex-1 text-left" onClick={props.onOpen}>
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{props.reference.sessionTitle}</span>
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground">
            <ProjectAvatar name={props.reference.projectName} className="size-3.5 rounded text-[8px]" />
            {props.reference.projectName}
          </span>
          {props.meta && <span className="ml-auto shrink-0 text-[12px] text-muted-foreground tabular-nums">{props.meta}</span>}
        </div>
        {props.detail && <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{props.detail}</div>}
      </button>
      {props.actions ?? <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
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
  const nothingPending = waiting.length === 0 && running.length === 0 && taskResults.length === 0;
  const open = (reference: SessionReference) => props.onOpenSession(reference.projectId, reference.sessionId);

  return (
    <section className="h-full overflow-y-auto bg-background">
      <div className="mx-auto grid w-full max-w-2xl min-w-0 animate-in grid-cols-[minmax(0,1fr)] gap-8 px-6 py-10 fade-in duration-200">
        <header>
          <h1 className="text-[20px] font-semibold">Heute</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}
            {overview && nothingPending && " · Nichts wartet auf dich."}
          </p>
        </header>

        {waiting.length > 0 && (
          <Section title="Wartet auf dich">
            {waiting.map(({ permissionRequest, reference }) => (
              <SessionRow
                key={permissionRequest.requestId}
                reference={reference}
                leading={
                  isQuestionRequest(permissionRequest.toolName) ? <MessageCircleQuestion className="size-4 text-status-waiting" /> : <ShieldAlert className="size-4 text-status-waiting" />
                }
                detail={
                  isQuestionRequest(permissionRequest.toolName)
                    ? `Frage: ${questionsOf(permissionRequest.input).map((question) => question.question).join(" · ")}`
                    : `${permissionRequest.toolName}: ${summarizeToolInput(permissionRequest.input) || JSON.stringify(permissionRequest.input).slice(0, 120)}`
                }
                onOpen={() => open(reference)}
                actions={
                  isQuestionRequest(permissionRequest.toolName) ? (
                    <Button size="sm" className="h-7 shrink-0" onClick={() => open(reference)}>
                      Beantworten
                    </Button>
                  ) : (
                  <div className="flex shrink-0 gap-1.5">
                    <Button size="sm" className="h-7" onClick={() => props.onAnswerPermission(permissionRequest.requestId, true)}>
                      Erlauben
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7" onClick={() => props.onAnswerPermission(permissionRequest.requestId, false)}>
                      Ablehnen
                    </Button>
                  </div>
                  )
                }
              />
            ))}
          </Section>
        )}

        {running.length > 0 && (
          <Section title="Läuft">
            {running.map((reference) => (
              <SessionRow key={reference.sessionId} reference={reference} leading={<Loader2 className="size-4 animate-spin text-status-running" />} onOpen={() => open(reference)} />
            ))}
          </Section>
        )}

        {taskResults.length > 0 && (
          <Section title="Task-Ergebnisse">
            {taskResults.map((taskRun) =>
              taskRun.session ? (
                <SessionRow
                  key={taskRun.id}
                  reference={{ ...taskRun.session, sessionTitle: taskRun.taskName }}
                  leading={taskRun.status === "success" ? <CheckCircle2 className="size-4 text-status-running" /> : <CircleAlert className="size-4 text-destructive" />}
                  meta={formatRelativeTime(taskRun.finishedAt ?? taskRun.startedAt)}
                  detail={taskRun.summary ?? undefined}
                  onOpen={() => open(taskRun.session!)}
                />
              ) : null,
            )}
          </Section>
        )}

        {overview && overview.recentSessions.length > 0 && (
          <Section title="Weitermachen">
            {overview.recentSessions.map((reference) => (
              <SessionRow
                key={reference.sessionId}
                reference={reference}
                leading={<MessageSquare className="size-4 text-muted-foreground" />}
                meta={formatRelativeTime(reference.updatedAt)}
                onOpen={() => open(reference)}
              />
            ))}
          </Section>
        )}
      </div>
    </section>
  );
}
