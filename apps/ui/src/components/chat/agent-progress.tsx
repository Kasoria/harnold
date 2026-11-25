import { useState } from "react";
import { CheckCircle2, ChevronRight, Circle, CircleDot, ListChecks, Square, TerminalSquare, Users } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { BackgroundTask, ChatItem } from "@/types";

export type TodoEntry = { id: string; content: string; activeForm?: string; status: "pending" | "in_progress" | "completed" };

const todoStatuses = new Set(["pending", "in_progress", "completed"]);

/**
 * The agent's task list from the conversation: the latest TodoWrite wins (full list);
 * TaskCreate/TaskUpdate (newer Claude Code) are replayed in order.
 */
export function todosFromChat(chatItems: ChatItem[]): TodoEntry[] {
  let todos: TodoEntry[] = [];
  const createdTaskByToolUse = new Map<string, TodoEntry>();
  for (const chatItem of chatItems) {
    if (chatItem.kind === "tool_use") {
      const toolInput = (chatItem.input ?? {}) as Record<string, unknown>;
      if (chatItem.toolName === "TodoWrite" && Array.isArray(toolInput.todos)) {
        todos = (toolInput.todos as { content?: string; activeForm?: string; status?: string }[]).map((todo, todoIndex) => ({
          id: String(todoIndex),
          content: String(todo.content ?? ""),
          activeForm: todo.activeForm,
          status: todoStatuses.has(String(todo.status)) ? (todo.status as TodoEntry["status"]) : "pending",
        }));
      } else if (chatItem.toolName === "TaskCreate") {
        const createdTask: TodoEntry = { id: String(todos.length + 1), content: String(toolInput.subject ?? ""), activeForm: toolInput.activeForm as string | undefined, status: "pending" };
        createdTaskByToolUse.set(chatItem.toolUseId, createdTask);
        todos = [...todos, createdTask];
      } else if (chatItem.toolName === "TaskUpdate") {
        const taskId = String(toolInput.taskId ?? "");
        const nextStatus = String(toolInput.status ?? "");
        todos =
          nextStatus === "deleted"
            ? todos.filter((todo) => todo.id !== taskId)
            : todos.map((todo) =>
                todo.id === taskId
                  ? { ...todo, ...(todoStatuses.has(nextStatus) ? { status: nextStatus as TodoEntry["status"] } : {}), ...(toolInput.subject ? { content: String(toolInput.subject) } : {}) }
                  : todo,
              );
      }
    } else if (chatItem.kind === "tool_result" && !chatItem.isError) {
      // The id Claude Code assigned ("Task #3 created …") replaces the guessed one.
      const createdTask = createdTaskByToolUse.get(chatItem.toolUseId);
      const assignedId = /#(\d+)/.exec(chatItem.content)?.[1] ?? /"id"\s*:\s*"?(\w+)/.exec(chatItem.content)?.[1];
      if (createdTask && assignedId) createdTask.id = assignedId;
    }
  }
  return todos.filter((todo) => todo.content);
}

/** Checklist like Claude Code's: open while work is left, collapsible. */
export function TodoPanel({ todos }: { todos: TodoEntry[] }) {
  const [open, setOpen] = useState(true);
  const doneCount = todos.filter((todo) => todo.status === "completed").length;
  const currentTodo = todos.find((todo) => todo.status === "in_progress");
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card px-3 py-2 text-[13px]">
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
        <ListChecks className="size-4 text-muted-foreground" />
        <span className="font-medium">{t("Aufgaben")}</span>
        <span className="text-muted-foreground tabular-nums">
          {doneCount}/{todos.length}
        </span>
        {!open && currentTodo && <span className="truncate text-muted-foreground">· {currentTodo.activeForm || currentTodo.content}</span>}
        <ChevronRight className={cn("ml-auto size-3.5 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-animated">
        <ul className="mt-1.5 grid max-h-52 gap-1 overflow-auto">
          {todos.map((todo) => (
            <li key={todo.id} className="flex items-start gap-2">
              {todo.status === "completed" ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : todo.status === "in_progress" ? (
                <CircleDot className="mt-0.5 size-3.5 shrink-0 text-status-waiting" />
              ) : (
                <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className={cn(todo.status === "completed" && "text-muted-foreground line-through", todo.status === "in_progress" && "font-medium")}>
                {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Background work that outlives the turn (Bash in the background, background subagents), each stoppable. */
export function BackgroundTasksBar({ tasks, onStop }: { tasks: BackgroundTask[]; onStop: (taskId: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tasks.map((backgroundTask) => {
        const TaskIcon = backgroundTask.taskType === "local_bash" || backgroundTask.taskType === "bash" ? TerminalSquare : Users;
        return (
          <div key={backgroundTask.id} className="flex max-w-full items-center gap-1.5 rounded-full border bg-card py-1 pr-1 pl-2.5 text-[12px]">
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-status-waiting" aria-hidden />
            <TaskIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate" title={backgroundTask.description}>
              {backgroundTask.description || t("Hintergrund-Aufgabe")}
            </span>
            <button
              type="button"
              className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t("Stoppen")}
              aria-label={t("Stoppen")}
              onClick={() => onStop(backgroundTask.id)}
            >
              <Square className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
