import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectStore } from "./db.ts";
import { eventHub } from "./events.ts";
import { environmentStore } from "./environments.ts";
import { t } from "./i18n.ts";

/**
 * Secrets the agent asks the user for (API keys etc.). The value goes from the input field straight into the
 * environment's variables – it never appears in chat history, events or the agent's context.
 * The request travels as a permission request ("SecretInput") so the UI's waiting logic and cleanup apply unchanged.
 */
export const secretInputToolName = "SecretInput";

export type SecretScope = "environment" | "project";
type PendingSecret = { sessionId: string; projectId: string; key: string; description: string; secret: boolean; scope: SecretScope; file: string; resolve: (outcome: "saved" | "cancelled") => void };
const pendingSecrets = new Map<string, PendingSecret>();

/** Absolute path of an env file inside the project folder; no traversal out of it. */
function projectEnvFile(projectId: string, file: string): string {
  const project = projectStore.get(projectId);
  if (!project) throw new Error(t("Projekt nicht gefunden"));
  const root = path.resolve(project.path);
  const target = path.resolve(root, file);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(t("Datei muss im Projektordner liegen"));
  if (target === root) throw new Error(t("Ungültiger Dateiname"));
  return target;
}

const formatEnvValue = (value: string) => (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value) ? value : JSON.stringify(value));

/** Sets KEY=value in an env file (replaces an existing line) and makes sure git ignores the file. */
function writeProjectEnv(projectId: string, file: string, key: string, value: string): void {
  const target = projectEnvFile(projectId, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const line = `${key}=${formatEnvValue(value)}`;
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const lines = existing.split("\n");
  const index = lines.findIndex((entry) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(entry));
  if (index >= 0) lines[index] = line;
  else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }
  fs.writeFileSync(target, lines.join("\n"), { mode: 0o600 });
  const root = path.resolve(projectStore.get(projectId)!.path);
  const relative = path.relative(root, target).split(path.sep).join("/");
  const ignoreFile = path.join(root, ".gitignore");
  const ignoreText = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "";
  const ignored = ignoreText.split("\n").some((entry) => [relative, `/${relative}`, path.basename(relative)].includes(entry.trim()));
  if (!ignored) fs.appendFileSync(ignoreFile, `${ignoreText && !ignoreText.endsWith("\n") ? "\n" : ""}/${relative}\n`);
}

export const secretInput = {
  /** Asks the user for one variable of the project's environment; resolves once it is saved or skipped. */
  request(input: { sessionId: string; projectId: string; key: string; description: string; secret: boolean; scope: SecretScope; file: string }): Promise<"saved" | "cancelled"> {
    const environment = environmentStore.forProject(input.projectId);
    if (input.scope === "project") projectEnvFile(input.projectId, input.file);
    else if (!environment) throw new Error(t("Projekt gehört zu keiner Umgebung – zuerst eine Umgebung zuweisen (project_set_environment) oder anlegen."));
    return new Promise((resolve) => {
      const requestId = randomUUID();
      pendingSecrets.set(requestId, { ...input, resolve });
      eventHub.publish({
        type: "permission_request",
        sessionId: input.sessionId,
        requestId,
        toolName: secretInputToolName,
        input: { key: input.key, description: input.description, secret: input.secret, scope: input.scope, file: input.file, environmentName: environment?.name ?? "" },
      });
    });
  },

  /** Stores the value; false when the request is gone. */
  submit(requestId: string, value: string): boolean {
    const pending = pendingSecrets.get(requestId);
    if (!pending) return false;
    if (pending.scope === "project") writeProjectEnv(pending.projectId, pending.file, pending.key, value);
    else {
      const environment = environmentStore.forProject(pending.projectId);
      if (!environment) throw new Error(t("Projekt gehört zu keiner Umgebung"));
      environmentStore.save(environment.id, { variables: [{ key: pending.key, value, secret: pending.secret }] });
    }
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
      input: { key: pending.key, description: pending.description, secret: pending.secret, scope: pending.scope, file: pending.file, environmentName: environmentStore.forProject(pending.projectId)?.name ?? "" },
    }));
  },
};
