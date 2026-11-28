import { createPortal } from "react-dom";
import { PermissionCard } from "@/components/chat/permission-card";
import { isQuestionRequest } from "@/components/chat/question-card";
import { isSecretInputRequest } from "@/components/chat/secret-input-card";
import { Button } from "@/components/ui/button";
import { usePermissionPipWindow } from "@/lib/permission-pip";
import { t } from "@/lib/i18n";
import type { PermissionAnswer, PermissionRequest, SessionReference } from "@/types";

/** All open approvals of every chat in a small floating window (Document Picture-in-Picture). */
export function PermissionPipHost(props: {
  requests: PermissionRequest[];
  sessionReferenceFor: (sessionId: string) => SessionReference | null;
  onAnswer: (requestId: string, answer: PermissionAnswer) => void;
  onOpenSession: (reference: SessionReference) => void;
}) {
  const pipWindow = usePermissionPipWindow();
  if (!pipWindow) return null;
  return createPortal(
    <div className="grid gap-2 p-2">
      {props.requests.length === 0 && <p className="p-4 text-center text-[13px] text-muted-foreground">{t("Keine offenen Anfragen")}</p>}
      {props.requests.map((request) => {
        const reference = props.sessionReferenceFor(request.sessionId);
        const needsChat = isQuestionRequest(request.toolName) || isSecretInputRequest(request.toolName);
        return (
          <div key={request.requestId} className="grid gap-1">
            {reference && (
              <div className="truncate px-1 text-[11px] text-muted-foreground">
                {reference.projectName} · {reference.sessionTitle}
              </div>
            )}
            {needsChat ? (
              <div className="rounded-xl border bg-card p-3 text-[13px]">
                <p className="mb-2">{t("Diese Anfrage brauchst du im Chat zu beantworten.")}</p>
                {reference && (
                  <Button
                    size="sm"
                    onClick={() => {
                      window.focus();
                      props.onOpenSession(reference);
                    }}
                  >
                    {t("Chat öffnen")}
                  </Button>
                )}
              </div>
            ) : (
              <PermissionCard request={request} onAnswer={(answer) => props.onAnswer(request.requestId, answer)} />
            )}
          </div>
        );
      })}
    </div>,
    pipWindow.document.body,
  );
}
