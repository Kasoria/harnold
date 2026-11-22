import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentMessageStore, type ChatItemPayload } from "../../db.ts";
import { resolveInsideProject } from "../../files.ts";
import { designSystemsDirectory } from "../../design-system.ts";
import { environmentStore } from "../../environments.ts";
import { environmentMemoryDirectory, memoryConfig } from "../../memory.ts";
import { providerStore } from "../../providers.ts";
import { t } from "../../i18n.ts";
import { streamModel, type ChatMessage, type ContentPart, type ModelEvent, type ToolCall, type ToolDefinition } from "./model-adapters.ts";
import { askUserQuestionDefinition, nativeToolByName, nativeTools, type NativeToolContext, type ToolRisk } from "./tools.ts";
import { connectMcpTools, type McpToolHandle } from "./mcp-tools.ts";
import type { PermissionMode, TurnEvent, TurnInput } from "../types.ts";
import { parseNativeModel } from "./settings.ts";
import { agentExtensions, type ExtensionSkill } from "../../agent-extensions.ts";
import { folderStore } from "../../folders.ts";
import { eventHub } from "../../events.ts";

/** History is stored with image paths, not image bytes; bytes are read per request. */
type StoredPart = ContentPart | { type: "image_file"; mimeType: string; path: string };
type StoredMessage = Exclude<ChatMessage, { role: "user" }> | { role: "user"; content: StoredPart[] };

const maxSteps = 100;
const historyCharacterBudget = 400_000; // ≈ 100k tokens
const oldToolResultLimit = 2_000;

function hydrate(messages: StoredMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    return {
      role: "user",
      content: message.content.map((part): ContentPart => {
        if (part.type !== "image_file") return part;
        try {
          return { type: "image", mimeType: part.mimeType, data: fs.readFileSync(part.path).toString("base64") };
        } catch {
          return { type: "text", text: "[Bild nicht mehr vorhanden]" };
        }
      }),
    };
  });
}

/** Ergänzt fehlende Tool-Ergebnisse (z. B. nach hartem Beenden mitten im Turn), sonst lehnt der Anbieter die Anfrage ab. Gibt null zurück, wenn nichts zu reparieren war. */
function withMissingToolResults(messages: StoredMessage[]): StoredMessage[] | null {
  const repaired: StoredMessage[] = [];
  let changed = false;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    repaired.push(message);
    if (message.role !== "assistant" || !message.toolCalls.length) continue;
    const answered = new Set<string>();
    let following = index + 1;
    while (following < messages.length && messages[following].role === "tool") {
      answered.add((messages[following] as { toolCallId: string }).toolCallId);
      repaired.push(messages[following]);
      following++;
    }
    index = following - 1;
    for (const call of message.toolCalls) {
      if (answered.has(call.id)) continue;
      repaired.push({ role: "tool", toolCallId: call.id, name: call.name, content: "Abgebrochen", isError: true });
      changed = true;
    }
  }
  return changed ? repaired : null;
}

const sizeOf = (message: StoredMessage) => JSON.stringify(message).length;

/** Keeps the history under budget: shortens old tool output first, then drops the oldest exchanges. */
function trimmed(messages: StoredMessage[]): StoredMessage[] | null {
  let total = messages.reduce((sum, message) => sum + sizeOf(message), 0);
  if (total <= historyCharacterBudget) return null;
  const result = [...messages];
  for (let index = 0; index < result.length - 6 && total > historyCharacterBudget; index++) {
    const message = result[index];
    if (message.role === "tool" && message.content.length > oldToolResultLimit) {
      const shortened = { ...message, content: `${message.content.slice(0, oldToolResultLimit)}\n[… gekürzt]` };
      total += sizeOf(shortened) - sizeOf(message);
      result[index] = shortened;
    }
  }
  // Drop from the front, always cutting at a user message so tool calls keep their results.
  while (total > historyCharacterBudget && result.length > 2) {
    const nextUserIndex = result.findIndex((message, index) => index > 0 && message.role === "user");
    if (nextUserIndex <= 0) break;
    for (const removed of result.splice(0, nextUserIndex)) total -= sizeOf(removed);
  }
  return result;
}

/** Path-like tool inputs – the value the agent wants to touch outside the allowed folders. */
const pathArgumentsOf = (toolInput: Record<string, unknown>): string[] =>
  ["file_path", "path", "directory", "folder", "cwd", "glob_path"]
    .map((key) => toolInput[key])
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));

/** Too broad to hand out: the whole disk or the entire home folder. */
const isTooBroadFolder = (folderPath: string) => folderPath === "/" || folderPath === os.homedir();

const isInside = (candidatePath: string, rootDirectory: string) =>
  candidatePath === rootDirectory || candidatePath.startsWith(rootDirectory.endsWith("/") ? rootDirectory : `${rootDirectory}/`);

type Verdict = "allow" | "ask" | "deny";
function verdictFor(risk: ToolRisk, mode: PermissionMode): Verdict {
  if (mode === "bypassPermissions" || risk === "read") return "allow";
  if (risk === "edit") return mode === "plan" ? "deny" : mode === "acceptEdits" ? "allow" : "ask";
  if (risk === "network") return "ask";
  return mode === "plan" ? "deny" : "ask";
}

function systemPrompt(input: TurnInput, cwd: string, mcpTools: McpToolHandle[], skills: ExtensionSkill[]): string {
  const lines = [
    "Du bist Harnolds Agent: ein Assistent, der im Projekt des Nutzers arbeitet, Dateien liest und ändert, Befehle ausführt und Fragen beantwortet.",
    `Arbeitsverzeichnis: ${cwd}`,
    `Plattform: ${process.platform} · Datum: ${new Date().toISOString().slice(0, 10)}`,
    "Arbeite selbstständig mit den Werkzeugen. Lies Dateien, bevor du sie änderst. Nutze Edit für gezielte Änderungen, Write nur für neue Dateien oder komplette Neufassungen.",
    "Antworte knapp und in der Sprache des Nutzers. Wenn eine Entscheidung beim Nutzer liegt, frage mit AskUserQuestion.",
    mcpTools.length ? "Werkzeuge mit Präfix mcp_ kommen von verbundenen Diensten (Harnold-Gedächtnis, Medien, Integrationen)." : "",
    skills.length
      ? `Skills (Anleitungen für bestimmte Aufgaben). Passt eine zur Aufgabe, lade sie zuerst mit dem Werkzeug Skill und folge ihr:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`
      : "",
    input.permissionMode === "plan" ? "Planungsmodus: Ändere nichts und führe keine Befehle aus. Untersuche, dann lege einen Plan vor." : "",
  ];
  return [lines.filter(Boolean).join("\n"), input.systemPromptAppend].filter(Boolean).join("\n\n");
}

const skillToolDefinition: ToolDefinition = {
  name: "Skill",
  description: "Lädt die Anleitung eines Skills (siehe Liste im Systemprompt). Danach der Anleitung folgen.",
  inputSchema: { type: "object", properties: { skill: { type: "string", description: "Name des Skills" }, args: { type: "string", description: "Optionale Angaben für den Skill" } }, required: ["skill"] },
};

const skillText = (skill: ExtensionSkill) => `Skill „${skill.name}“ (Basisverzeichnis: ${skill.directory}):\n\n${agentExtensions.readSkill(skill)}`;

/** "/name args" → the command's prompt or the skill's instructions; anything else stays as typed. */
function expandSlashCommand(promptText: string, project: TurnInput["project"], skills: ExtensionSkill[]): string {
  const match = promptText.match(/^\/([\w:.-]+)(?:[ \t]+([\s\S]*))?$/);
  if (!match) return promptText;
  const [, name, argumentText = ""] = match;
  const command = agentExtensions.commands(project).find((candidate) => candidate.name === name);
  if (command) return agentExtensions.expandCommand(command, argumentText);
  const skill = skills.find((candidate) => candidate.name === name);
  if (skill) return `${skillText(skill)}${argumentText.trim() ? `\n\n---\n\n${argumentText.trim()}` : ""}`;
  return promptText;
}

function userMessageFor(input: TurnInput, promptText: string): StoredMessage {
  const parts: StoredPart[] = [];
  const references: string[] = [];
  for (const attachment of input.attachments) {
    const absolutePath = resolveInsideProject(input.project, attachment.path);
    if (!fs.existsSync(absolutePath)) continue;
    if (attachment.mimeType.startsWith("image/")) parts.push({ type: "image_file", mimeType: attachment.mimeType, path: absolutePath });
    references.push(`Angehängt: ${attachment.name} (liegt unter ${attachment.path})`);
  }
  parts.unshift({ type: "text", text: [...references, promptText].filter(Boolean).join("\n\n") });
  return { role: "user", content: parts };
}

const answersOf = (updatedInput: Record<string, unknown> | undefined): string => {
  const answers = (updatedInput?.answers ?? {}) as Record<string, string>;
  const lines = Object.entries(answers).map(([question, answer]) => `${question}\n→ ${answer}`);
  return lines.length ? lines.join("\n\n") : "Der Nutzer hat die Fragen übersprungen.";
};

/** One turn of Harnold's own agent loop: model ↔ tools until the model answers without tool calls. */
export async function* runNativeTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
  const startedAt = Date.now();
  const parsedModel = parseNativeModel(input.model);
  const provider = parsedModel ? providerStore.get(parsedModel.providerId) : undefined;
  if (!parsedModel || !provider) throw new Error(t("Kein Modell gewählt. Lege unter Einstellungen → Agent einen Anbieter an."));
  if (!provider.ready) throw new Error(t("Anbieter „{0}“ ist nicht fertig eingerichtet (API-Key fehlt?).", provider.name));

  yield { type: "session_started", agentSessionId: input.sessionId };
  const { sessionId } = input;
  if (!input.resumeSessionId) agentMessageStore.clear(sessionId);
  const history = agentMessageStore.list(sessionId) as StoredMessage[];
  const repairedHistory = withMissingToolResults(history);
  if (repairedHistory) {
    history.splice(0, history.length, ...repairedHistory);
    agentMessageStore.replace(sessionId, history);
  }
  const remember = (message: StoredMessage) => {
    history.push(message);
    agentMessageStore.append(sessionId, message);
  };
  const skills = agentExtensions.skills(input.project);
  remember(userMessageFor(input, expandSlashCommand(input.promptText, input.project, skills)));

  const cwd = input.project.path || os.homedir();
  const projectEnvironment = environmentStore.forProject(input.project.id);
  const toolContext: NativeToolContext = {
    cwd,
    allowedRoots: [cwd, designSystemsDirectory, memoryConfig.workspaceDirectory(), ...(projectEnvironment ? [environmentMemoryDirectory(projectEnvironment.id)] : []), ...agentExtensions.readableRoots(input.project), ...input.session.directories],
    env: input.env,
    signal: input.signal,
    permissionMode: input.permissionMode,
  };

  const mcp = await connectMcpTools(input.project, sessionId, input.permissionMode);
  for (const warning of mcp.warnings) yield { type: "item", payload: { kind: "notice", text: t("MCP-Server nicht verbunden: {0}", warning) } };
  const mcpByName = new Map(mcp.tools.map((tool) => [tool.name, tool]));
  const toolDefinitions: ToolDefinition[] = [
    ...nativeTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    askUserQuestionDefinition,
    ...(skills.length ? [skillToolDefinition] : []),
    ...mcp.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  ];

  let finalText = "";
  let success = false;
  let errorText: string | undefined;
  let contextTokens: number | undefined;

  const runTool = async (call: ToolCall): Promise<{ content: string; isError: boolean }> => {
    if (call.name === askUserQuestionDefinition.name) {
      const decision = await input.requestPermission("AskUserQuestion", call.input, input.signal);
      return { content: decision.behavior === "allow" ? answersOf(decision.updatedInput) : "Der Nutzer hat die Fragen übersprungen.", isError: false };
    }
    if (call.name === skillToolDefinition.name) {
      const skill = skills.find((candidate) => candidate.name === call.input.skill);
      if (!skill) return { content: `Skill nicht gefunden: ${String(call.input.skill)}. Verfügbar: ${skills.map((candidate) => candidate.name).join(", ")}`, isError: true };
      const extra = typeof call.input.args === "string" && call.input.args.trim() ? `\n\n---\nAngaben: ${call.input.args.trim()}` : "";
      return { content: `${skillText(skill)}${extra}`, isError: false };
    }
    const nativeTool = nativeToolByName.get(call.name);
    const mcpTool = mcpByName.get(call.name);
    if (!nativeTool && !mcpTool) return { content: `Unbekanntes Werkzeug: ${call.name}`, isError: true };
    const verdict: Verdict = nativeTool
      ? verdictFor(nativeTool.risk, input.permissionMode)
      : mcpTool!.autoAllow || input.permissionMode === "bypassPermissions"
        ? "allow"
        : input.permissionMode === "plan"
          ? "deny"
          : "ask";
    if (verdict === "deny") return { content: "Im Planungsmodus nicht erlaubt.", isError: true };
    // A path outside the project (a customer folder, another repo …): ask once, then remember the folder.
    const outsideFolder = nativeTool
      ? pathArgumentsOf(call.input)
          .map((candidatePath) => path.resolve(cwd, candidatePath))
          .find((candidatePath) => !toolContext.allowedRoots.some((rootDirectory) => isInside(candidatePath, rootDirectory)))
      : undefined;
    const folderOfOutsidePath = outsideFolder && (fs.statSync(outsideFolder, { throwIfNoEntry: false })?.isDirectory() ? outsideFolder : path.dirname(outsideFolder));
    if (outsideFolder && folderOfOutsidePath && !isTooBroadFolder(folderOfOutsidePath)) {
      const folderToAllow = folderOfOutsidePath;
      const decision = await input.requestPermission("FolderAccess", { path: folderToAllow }, input.signal);
      if (decision.behavior === "deny") return { content: `Zugriff auf ${folderToAllow} nicht erlaubt.`, isError: true };
      toolContext.allowedRoots.push(folderToAllow);
      // Freigegeben ist gespeichert: der Ordner gehört ab jetzt zum Projekt-Kontext.
      folderStore.add("project", input.project.id, folderToAllow);
      eventHub.publish({ type: "folders_changed" });
    }
    let toolInput = call.input;
    if (verdict === "ask") {
      const decision = await input.requestPermission(mcpTool?.qualifiedName ?? call.name, call.input, input.signal);
      if (decision.behavior === "deny") return { content: decision.message || "Vom Nutzer abgelehnt.", isError: true };
      toolInput = decision.updatedInput ?? call.input;
    }
    try {
      if (nativeTool) return { content: await nativeTool.run(toolInput, toolContext), isError: false };
      const result = await mcpTool!.call(toolInput, input.signal);
      return { content: result.text, isError: result.isError };
    } catch (toolError) {
      return { content: toolError instanceof Error ? toolError.message : String(toolError), isError: true };
    }
  };

  try {
    for (let step = 0; step < maxSteps; step++) {
      const shortened = trimmed(history);
      if (shortened) {
        history.splice(0, history.length, ...shortened);
        agentMessageStore.replace(sessionId, history);
      }

      let reasoning = "";
      let done: Extract<ModelEvent, { type: "done" }> | null = null;
      for await (const modelEvent of streamModel(provider.protocol, {
        baseUrl: provider.baseUrl,
        apiKey: providerStore.apiKeyOf(provider.id),
        model: parsedModel.modelId,
        system: systemPrompt(input, cwd, mcp.tools, skills),
        messages: hydrate(history),
        tools: toolDefinitions,
        signal: input.signal,
        // Same key for every step of a conversation: the provider can serve the grown prefix from its cache.
        cacheKey: sessionId,
      })) {
        if (modelEvent.type === "text_delta") yield { type: "text_delta", text: modelEvent.text };
        else if (modelEvent.type === "reasoning_delta") {
          reasoning += modelEvent.text;
          yield { type: "thinking_delta", text: modelEvent.text };
        } else done = modelEvent;
      }
      if (!done) throw new Error(t("Das Modell hat die Antwort abgebrochen."));

      if (reasoning.trim()) yield { type: "item", payload: { kind: "thinking", text: reasoning } };
      if (done.text.trim()) {
        finalText = done.text;
        yield { type: "item", payload: { kind: "assistant_text", text: done.text } };
      }
      remember({ role: "assistant", text: done.text, toolCalls: done.toolCalls });
      if (done.inputTokens) {
        contextTokens = done.inputTokens + done.outputTokens;
        yield { type: "context_size", tokens: contextTokens };
      }
      if (!done.toolCalls.length) {
        success = true;
        break;
      }

      for (const call of done.toolCalls) {
        const shownName = mcpByName.get(call.name)?.qualifiedName ?? call.name;
        yield { type: "item", payload: { kind: "tool_use", toolUseId: call.id, toolName: shownName, input: call.input } satisfies ChatItemPayload };
        const result = input.signal.aborted ? { content: "Abgebrochen", isError: true } : await runTool(call);
        yield { type: "item", payload: { kind: "tool_result", toolUseId: call.id, ...result } };
        remember({ role: "tool", toolCallId: call.id, name: call.name, content: result.content, isError: result.isError });
      }
      if (input.signal.aborted) throw new Error("Abgebrochen");
      if (step === maxSteps - 1) errorText = t("Nach {0} Schritten angehalten.", maxSteps);
    }
  } catch (turnError) {
    if (input.signal.aborted) throw turnError;
    errorText = turnError instanceof Error ? turnError.message : String(turnError);
  } finally {
    // Every tool call needs a result, or the next request is rejected.
    const last = history[history.length - 1];
    if (last?.role === "assistant" && last.toolCalls.length) {
      for (const call of last.toolCalls) agentMessageStore.append(sessionId, { role: "tool", toolCallId: call.id, name: call.name, content: "Abgebrochen", isError: true } satisfies StoredMessage);
    } else if (last?.role === "tool") {
      const answered = new Set<string>();
      for (let index = history.length - 1; index >= 0 && history[index].role === "tool"; index--) answered.add((history[index] as { toolCallId: string }).toolCallId);
      const assistant = [...history].reverse().find((message) => message.role === "assistant") as Extract<StoredMessage, { role: "assistant" }> | undefined;
      for (const call of assistant?.toolCalls ?? [])
        if (!answered.has(call.id)) agentMessageStore.append(sessionId, { role: "tool", toolCallId: call.id, name: call.name, content: "Abgebrochen", isError: true } satisfies StoredMessage);
    }
    await mcp.close();
  }

  yield { type: "item", payload: { kind: "turn_result", success, costUsd: 0, durationMs: Date.now() - startedAt, errorText, contextTokens } };
  yield { type: "outcome", success, finalText, errorText };
}
