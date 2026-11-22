import type { ProviderProtocol } from "../../providers.ts";

/**
 * Provider-neutral model access for Harnold's own agent. One adapter per wire protocol; every provider that
 * speaks OpenAI chat-completions (OpenAI, Gemini, Mistral, Ollama, OpenRouter, …) or the Anthropic Messages API works.
 */
export type ContentPart = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ChatMessage =
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError: boolean };
export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

export type ModelRequest = {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
};
export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "done"; text: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number };

/** Server-sent events: yields the data payload of each event. */
async function* serverSentData(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let boundary: number;
    while ((boundary = buffered.search(/\r?\n\r?\n/)) >= 0) {
      const rawEvent = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = (await response.text().catch(() => "")).slice(0, 600);
  throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

const parseArguments = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------- OpenAI-compatible (chat completions)

function openAiMessages(request: ModelRequest): unknown[] {
  const messages: unknown[] = [{ role: "system", content: request.system }];
  for (const message of request.messages) {
    if (message.role === "user") {
      const hasImage = message.content.some((part) => part.type === "image");
      messages.push({
        role: "user",
        content: hasImage
          ? message.content.map((part) => (part.type === "text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }))
          : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
      });
    } else if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.text || null,
        ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}),
      });
    } else {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    }
  }
  return messages;
}

async function* openAiStream(request: ModelRequest): AsyncGenerator<ModelEvent> {
  const response = await fetch(`${request.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}) },
    body: JSON.stringify({
      model: request.model,
      messages: openAiMessages(request),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: request.signal,
  });
  await assertOk(response);

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const data of serverSentData(response)) {
    if (data === "[DONE]") break;
    let chunk: {
      choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error?.message) throw new Error(chunk.error.message);
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      text += delta.content;
      yield { type: "text_delta", text: delta.content };
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) yield { type: "reasoning_delta", text: reasoning };
    for (const toolDelta of delta.tool_calls ?? []) {
      const index = toolDelta.index ?? 0;
      const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (toolDelta.id) current.id = toolDelta.id;
      if (toolDelta.function?.name) current.name += toolDelta.function.name;
      if (toolDelta.function?.arguments) current.arguments += toolDelta.function.arguments;
      toolCalls.set(index, current);
    }
  }
  yield {
    type: "done",
    text,
    toolCalls: [...toolCalls.entries()].sort(([first], [second]) => first - second).map(([index, call]) => ({ id: call.id || `call_${index}_${Date.now()}`, name: call.name, input: parseArguments(call.arguments) })),
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------- Anthropic Messages API

function anthropicMessages(request: ModelRequest): unknown[] {
  const messages: { role: "user" | "assistant"; content: unknown[] }[] = [];
  const push = (role: "user" | "assistant", blocks: unknown[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of request.messages) {
    if (message.role === "user") {
      push("user", message.content.map((part) => (part.type === "text" ? { type: "text", text: part.text } : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } })));
    } else if (message.role === "assistant") {
      const blocks: unknown[] = [];
      if (message.text) blocks.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      if (blocks.length) push("assistant", blocks);
    } else {
      push("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) }]);
    }
  }
  return messages;
}

async function* anthropicStream(request: ModelRequest): AsyncGenerator<ModelEvent> {
  const baseUrl = request.baseUrl.replace(/\/+$/, "");
  const officialHost = new URL(baseUrl).host.endsWith("anthropic.com");
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(request.apiKey ? { "x-api-key": request.apiKey } : {}),
      // Gateways in front of Anthropic-style APIs often expect a bearer token.
      ...(request.apiKey && !officialHost ? { authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: 16_000,
      system: request.system,
      messages: anthropicMessages(request),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
      stream: true,
    }),
    signal: request.signal,
  });
  await assertOk(response);

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const blocks = new Map<number, { kind: "text" | "tool_use" | "other"; id: string; name: string; json: string }>();
  for await (const data of serverSentData(response)) {
    let event: {
      type: string;
      index?: number;
      message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } };
      content_block?: { type: string; id?: string; name?: string };
      delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
      usage?: { output_tokens?: number };
      error?: { message?: string };
    };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "error") throw new Error(event.error?.message ?? "Anbieter-Fehler");
    if (event.type === "message_start" && event.message?.usage) {
      const usage = event.message.usage;
      inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    } else if (event.type === "content_block_start" && event.index !== undefined && event.content_block) {
      const kind = event.content_block.type === "text" ? "text" : event.content_block.type === "tool_use" ? "tool_use" : "other";
      blocks.set(event.index, { kind, id: event.content_block.id ?? "", name: event.content_block.name ?? "", json: "" });
    } else if (event.type === "content_block_delta" && event.index !== undefined && event.delta) {
      const block = blocks.get(event.index);
      if (event.delta.type === "text_delta" && event.delta.text) {
        text += event.delta.text;
        yield { type: "text_delta", text: event.delta.text };
      } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
        yield { type: "reasoning_delta", text: event.delta.thinking };
      } else if (event.delta.type === "input_json_delta" && block) block.json += event.delta.partial_json ?? "";
    } else if (event.type === "message_delta" && event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
  }
  yield {
    type: "done",
    text,
    toolCalls: [...blocks.entries()].sort(([first], [second]) => first - second).flatMap(([, block]) => (block.kind === "tool_use" ? [{ id: block.id, name: block.name, input: parseArguments(block.json) }] : [])),
    inputTokens,
    outputTokens,
  };
}

export const streamModel = (protocol: ProviderProtocol, request: ModelRequest): AsyncGenerator<ModelEvent> => (protocol === "anthropic" ? anthropicStream(request) : openAiStream(request));
