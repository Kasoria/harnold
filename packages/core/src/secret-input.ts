import { randomUUID } from "node:crypto";
import { eventHub } from "./events.ts";
import { environmentStore } from "./environments.ts";
import { t } from "./i18n.ts";

/**
 * Secrets the agent asks the user for (API keys etc.). The value goes from the input field straight into the
 * environment's variables – it never appears in chat history, events or the agent's context.
 * The request travels as a permission request ("SecretInput") so the UI's waiting logic and cleanup apply unchanged.
 */
export const secretInputToolName = "SecretInput";

type PendingSecret = { sessionId: string; projectId: string; key: string; description: string; secret: boolean; resolve: (outcome: "saved" | "cancelled") => void };
const pendingSecrets = new Map<string, PendingSecret>();

export const secretInput = {
  /** Asks the user for one variable of the project's environment; resolves once it is saved or skipped. */
  request(input: { sessionId: string; projectId: string; key: string; description: string; secret: boolean }): Promise<"saved" | "cancelled"> {
    const environment = environmentStore.forProject(input.projectId);
    if (!environment) throw new Error(t("Projekt gehört zu keiner Umgebung – zuerst eine Umgebung zuweisen (project_set_environment) oder anlegen."));
    return new Promise((resolve) => {
      const requestId = randomUUID();
      pendingSecrets.set(requestId, { ...input, resolve });
      eventHub.publish({
        type: "permission_request",
        sessionId: input.sessionId,
        requestId,
        toolName: secretInputToolName,
        input: { key: input.key, description: input.description, secret: input.secret, environmentName: environment.name },
      });
    });
  },

  /** Stores the value; false when the request is gone. */
  submit(requestId: string, value: string): boolean {
    const pending = pendingSecrets.get(requestId);
    if (!pending) return false;
    const environment = environmentStore.forProject(pending.projectId);
    if (!environment) throw new Error(t("Projekt gehört zu keiner Umgebung"));
    environmentStore.save(environment.id, { variables: [{ key: pending.key, value, secret: pending.secret }] });
    pendingSecrets.delete(requestId);
    pending.resolve("saved");
    eventHub.publish({ type: "permission_resolved", sessionId: pending.sessionId, requestId });
    return true;
  },

  cancel(requestId: string): boolean {
    const pending = pendingSecrets.get(requestId);
    if (!pending) return false;
    pendingSecrets.delete(requestId);
    pending.resolve("cancelled");
    eventHub.publish({ type: "permission_resolved", sessionId: pending.sessionId, requestId });
    return true;
  },

  /** Turn ended or was stopped: open requests of the session are void. */
  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of pendingSecrets) if (pending.sessionId === sessionId) secretInput.cancel(requestId);
  },

  listPending(): { requestId: string; sessionId: string; toolName: string; input: unknown }[] {
    return [...pendingSecrets].map(([requestId, pending]) => ({
      requestId,
      sessionId: pending.sessionId,
      toolName: secretInputToolName,
      input: { key: pending.key, description: pending.description, secret: pending.secret, environmentName: environmentStore.forProject(pending.projectId)?.name ?? "" },
    }));
  },
};
