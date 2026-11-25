import { useState } from "react";
import { ClipboardList, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { summarizeToolInput } from "@/components/chat/tool-group";
import { t } from "@/lib/i18n";
import type { PermissionAnswer, PermissionRequest } from "@/types";

type DiffLine = { kind: "same" | "removed" | "added"; text: string };

/** Line diff (LCS) – small enough for the snippets of an edit; long inputs fall back to removed/added blocks. */
function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];
  if (beforeLines.length * afterLines.length > 250_000) {
    return [...beforeLines.map((text) => ({ kind: "removed" as const, text })), ...afterLines.map((text) => ({ kind: "added" as const, text }))];
  }
  const commonLengths = Array.from({ length: beforeLines.length + 1 }, () => new Array<number>(afterLines.length + 1).fill(0));
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex--) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex--) {
      commonLengths[beforeIndex][afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? commonLengths[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(commonLengths[beforeIndex + 1][afterIndex], commonLengths[beforeIndex][afterIndex + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      lines.push({ kind: "same", text: beforeLines[beforeIndex] });
      beforeIndex++;
      afterIndex++;
    } else if (commonLengths[beforeIndex + 1][afterIndex] >= commonLengths[beforeIndex][afterIndex + 1]) {
      lines.push({ kind: "removed", text: beforeLines[beforeIndex++] });
    } else {
      lines.push({ kind: "added", text: afterLines[afterIndex++] });
    }
  }
  while (beforeIndex < beforeLines.length) lines.push({ kind: "removed", text: beforeLines[beforeIndex++] });
  while (afterIndex < afterLines.length) lines.push({ kind: "added", text: afterLines[afterIndex++] });
  return lines;
}

type EditPreview = { filePath: string; hunks: { before: string; after: string }[] };

/** Edit, MultiEdit and Write as before/after pairs; null for other tools. */
export function editPreviewOf(toolName: string, input: unknown): EditPreview | null {
  const toolInput = (input ?? {}) as { file_path?: string; old_string?: string; new_string?: string; content?: string; edits?: { old_string?: string; new_string?: string }[] };
  const filePath = String(toolInput.file_path ?? "");
  if (toolName === "Edit") return { filePath, hunks: [{ before: toolInput.old_string ?? "", after: toolInput.new_string ?? "" }] };
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    return { filePath, hunks: toolInput.edits.map((edit) => ({ before: edit.old_string ?? "", after: edit.new_string ?? "" })) };
  }
  if (toolName === "Write") return { filePath, hunks: [{ before: "", after: toolInput.content ?? "" }] };
  return null;
}

export function DiffView({ preview }: { preview: EditPreview }) {
  return (
    <div className="mt-2 max-h-80 overflow-auto rounded-lg border bg-background font-mono text-[11.5px] leading-[1.55]">
      {preview.hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex} className={hunkIndex ? "border-t border-dashed" : undefined}>
          {diffLines(hunk.before, hunk.after).map((line, lineIndex) => (
            <div
              key={lineIndex}
              className={
                line.kind === "added"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : line.kind === "removed"
                    ? "bg-red-500/10 text-red-700 dark:text-red-300"
                    : "text-muted-foreground"
              }
            >
              <span className="inline-block w-5 select-none pl-1.5 opacity-60">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
              <span className="whitespace-pre-wrap break-all">{line.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Deny with a reason the agent reads (e.g. what to change in the plan). */
function FeedbackField(props: { placeholder: string; onSend: (message: string) => void; onCancel: () => void }) {
  const [feedbackText, setFeedbackText] = useState("");
  return (
    <div className="mt-3 grid gap-2">
      <Textarea
        autoFocus
        value={feedbackText}
        placeholder={props.placeholder}
        className="min-h-16 text-[13px]"
        onChange={(event) => setFeedbackText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && feedbackText.trim()) {
            event.preventDefault();
            props.onSend(feedbackText);
          }
        }}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={!feedbackText.trim()} onClick={() => props.onSend(feedbackText)}>
          {t("Senden")}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          {t("Zurück")}
        </Button>
      </div>
    </div>
  );
}

/** Plan of the plan mode (ExitPlanMode): readable, approve with edits automatic or one by one, or keep planning. */
function PlanCard(props: { request: PermissionRequest; onAnswer: (answer: PermissionAnswer) => void }) {
  const [givingFeedback, setGivingFeedback] = useState(false);
  const planText = String((props.request.input as { plan?: string } | null)?.plan ?? "");
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 rounded-xl border bg-card p-3 shadow-xs duration-200">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <ClipboardList className="size-4 text-status-waiting" />
        {t("Plan bereit")}
      </div>
      {planText && (
        <div className="mt-2 max-h-[50vh] overflow-auto rounded-lg border bg-background px-3 py-2 text-[13.5px]">
          <ChatMarkdown text={planText} />
        </div>
      )}
      {givingFeedback ? (
        <FeedbackField
          placeholder={t("Was soll am Plan anders werden?")}
          onSend={(message) => props.onAnswer({ allow: false, message })}
          onCancel={() => setGivingFeedback(false)}
        />
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => props.onAnswer({ allow: true, permissionMode: "acceptEdits" })}>
            {t("Umsetzen, Edits automatisch")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => props.onAnswer({ allow: true, permissionMode: "default" })}>
            {t("Umsetzen, Edits einzeln bestätigen")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setGivingFeedback(true)}>
            {t("Weiter planen …")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Tool approval: diff for edits, "always allow" when the agent offers a rule, deny with a reason. */
export function PermissionCard(props: { request: PermissionRequest; onAnswer: (answer: PermissionAnswer) => void }) {
  const { request } = props;
  const [givingFeedback, setGivingFeedback] = useState(false);
  if (request.toolName === "ExitPlanMode") return <PlanCard request={request} onAnswer={props.onAnswer} />;
  const isFolderAccess = request.toolName === "FolderAccess";
  const editPreview = editPreviewOf(request.toolName, request.input);
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 rounded-xl border bg-card p-3 shadow-xs duration-200">
      <div className="flex items-center gap-2 text-[13px]">
        <ShieldAlert className="size-4 text-status-waiting" />
        <span>
          {isFolderAccess ? (
            t("Zugriff auf einen Ordner außerhalb des Projekts")
          ) : (
            <>
              <strong className="font-medium">{request.toolName}</strong> {t("möchte ausgeführt werden")}
            </>
          )}
        </span>
      </div>
      <div className="mt-1.5 truncate font-mono text-[12px] text-muted-foreground">
        {isFolderAccess
          ? String((request.input as { path?: string } | null)?.path ?? "")
          : editPreview
            ? editPreview.filePath
            : summarizeToolInput(request.input) || JSON.stringify(request.input).slice(0, 200)}
      </div>
      {editPreview && <DiffView preview={editPreview} />}
      {isFolderAccess && <p className="mt-1 text-[11.5px] text-muted-foreground">{t("Erlauben merkt sich den Ordner für dieses Projekt – danach wird nicht wieder gefragt.")}</p>}
      {givingFeedback ? (
        <FeedbackField
          placeholder={t("Was soll der Agent stattdessen tun?")}
          onSend={(message) => props.onAnswer({ allow: false, message })}
          onCancel={() => setGivingFeedback(false)}
        />
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => props.onAnswer({ allow: true })}>
            {t("Erlauben")}
          </Button>
          {request.alwaysAllowLabel && (
            <Button size="sm" variant="outline" title={request.alwaysAllowLabel} onClick={() => props.onAnswer({ allow: true, always: true })}>
              <span className="max-w-72 truncate">{t("Immer erlauben: {0}", request.alwaysAllowLabel)}</span>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => props.onAnswer({ allow: false })}>
            {t("Ablehnen")}
          </Button>
          {!isFolderAccess && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setGivingFeedback(true)}>
              {t("Anders machen …")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
