import { randomUUID } from "node:crypto";
import { z } from "zod";
import { settingsStore } from "./settings.ts";
import { eventHub } from "./events.ts";
import { assertAllowedHttpUrl } from "./network-guard.ts";
import { t } from "./i18n.ts";

/**
 * AI providers: any endpoint = protocol + base URL + API key + model ids.
 * - Harnold's own agent talks to every provider directly, over either protocol.
 * - Claude Code only speaks the Anthropic protocol (and has its own built-in "claude" provider, see claude-auth.ts).
 */
export type ProviderProtocol = "anthropic" | "openai";
export const claudeProviderId = "claude";

export type ProviderPreset = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** Suggested model ids (editable). */
  models: string[];
  needsKey: boolean;
  keyPlaceholder: string;
  hint?: string;
};

const preset = (id: string, name: string, protocol: ProviderProtocol, baseUrl: string, models: string[], needsKey: boolean, hint?: string, keyPlaceholder = ""): ProviderPreset => ({ id, name, protocol, baseUrl, models, needsKey, keyPlaceholder, hint });

export const providerPresets: ProviderPreset[] = [
  preset("openai", "OpenAI", "openai", "https://api.openai.com/v1", ["gpt-5"], true, undefined, "sk-…"),
  preset("anthropic", "Anthropic", "anthropic", "https://api.anthropic.com", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], true, undefined, "sk-ant-…"),
  preset("gemini", "Google Gemini", "openai", "https://generativelanguage.googleapis.com/v1beta/openai", ["gemini-2.5-pro", "gemini-2.5-flash"], true),
  preset("openrouter", "OpenRouter", "openai", "https://openrouter.ai/api/v1", [], true, "Ein Zugang zu hunderten Modellen verschiedener Anbieter.", "sk-or-…"),
  preset("mistral", "Mistral", "openai", "https://api.mistral.ai/v1", ["mistral-large-latest"], true),
  preset("xai", "xAI (Grok)", "openai", "https://api.x.ai/v1", ["grok-4"], true),
  preset("groq", "Groq", "openai", "https://api.groq.com/openai/v1", [], true),
  preset("together", "Together AI", "openai", "https://api.together.xyz/v1", [], true),
  preset("deepseek", "DeepSeek", "openai", "https://api.deepseek.com", ["deepseek-chat", "deepseek-reasoner"], true),
  preset("ollama", "Ollama (lokal)", "openai", "http://localhost:11434/v1", [], false, "Läuft auf diesem Rechner. Modelle wie bei `ollama list`."),
  preset("lmstudio", "LM Studio (lokal)", "openai", "http://localhost:1234/v1", [], false, "Läuft auf diesem Rechner."),
  preset("custom-openai", "Eigener Endpunkt (OpenAI-kompatibel)", "openai", "", [], false, "Jeder Dienst mit /chat/completions: vLLM, LiteLLM, Azure, …"),
  // Anthropic-protocol endpoints: usable by Claude Code too.
  preset("openrouter-anthropic", "OpenRouter (Anthropic-API)", "anthropic", "https://openrouter.ai/api", ["anthropic/claude-sonnet-4.5"], true, "Für Claude Code: Modelle anderer Anbieter über die Anthropic-Schnittstelle.", "sk-or-…"),
  preset("zai", "Z.ai (GLM)", "anthropic", "https://api.z.ai/api/anthropic", ["glm-4.6"], true),
  preset("moonshot", "Moonshot (Kimi)", "anthropic", "https://api.moonshot.ai/anthropic", ["kimi-k2-turbo-preview"], true),
  preset("custom-anthropic", "Eigener Endpunkt (Anthropic-kompatibel)", "anthropic", "", [], false, "Jeder Dienst mit der Anthropic-Messages-API."),
];

export type CustomProvider = { id: string; name: string; protocol: ProviderProtocol; baseUrl: string; models: string[]; needsKey: boolean };
export type ProviderView = CustomProvider & { apiKeySet: boolean; ready: boolean };
export type ProvidersView = { activeId: string; providers: ProviderView[]; presets: ProviderPreset[] };

export const providerInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  protocol: z.enum(["anthropic", "openai"]).default("anthropic"),
  baseUrl: z
    .string()
    .trim()
    .url()
    .transform((value) => value.replace(/\/+$/, "")),
  models: z.array(z.string().trim().min(1)).default([]),
  needsKey: z.boolean().default(true),
  /** Only sent when changed; "" removes the stored key. */
  apiKey: z.string().optional(),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;

const listKey = "providers.custom";
const activeKey = "providers.active";
const secretsKey = "providers.secrets";

// Providers saved before protocols existed were Anthropic-compatible endpoints for Claude Code.
const readList = (): CustomProvider[] => settingsStore.read<(Omit<CustomProvider, "protocol"> & { protocol?: ProviderProtocol })[]>(listKey, []).map((provider) => ({ ...provider, protocol: provider.protocol ?? "anthropic" }));
const readKeys = () => settingsStore.readSecrets(secretsKey);

function view(provider: CustomProvider): ProviderView {
  const apiKeySet = Boolean(readKeys()[provider.id]);
  return { ...provider, apiKeySet, ready: Boolean(provider.baseUrl) && (!provider.needsKey || apiKeySet) };
}

export const providerStore = {
  list: (): ProviderView[] => readList().map(view),
  get: (providerId: string): ProviderView | undefined => readList().map(view).find((provider) => provider.id === providerId),

  activeId(): string {
    const storedId = settingsStore.read<string>(activeKey, claudeProviderId);
    return storedId === claudeProviderId || readList().some((provider) => provider.id === storedId) ? storedId : claudeProviderId;
  },
  /** The active custom provider, or undefined when Claude is active. */
  // Claude Code speaks the Anthropic protocol only.
  active: (): ProviderView | undefined => {
    const activeProvider = providerStore.get(providerStore.activeId());
    return activeProvider?.protocol === "anthropic" ? activeProvider : undefined;
  },

  view: (): ProvidersView => ({ activeId: providerStore.activeId(), providers: providerStore.list(), presets: providerPresets }),

  create(input: ProviderInput): ProviderView {
    const provider: CustomProvider = { id: randomUUID(), name: input.name, protocol: input.protocol, baseUrl: input.baseUrl, models: input.models, needsKey: input.needsKey };
    settingsStore.write(listKey, [...readList(), provider]);
    if (input.apiKey?.trim()) settingsStore.writeSecrets(secretsKey, { ...readKeys(), [provider.id]: input.apiKey.trim() });
    eventHub.publish({ type: "claude_auth_changed" });
    return view(provider);
  },

  update(providerId: string, input: ProviderInput): ProviderView {
    const list = readList();
    const existing = list.find((provider) => provider.id === providerId);
    if (!existing) throw new Error(t("Anbieter nicht gefunden"));
    const updated: CustomProvider = { ...existing, name: input.name, protocol: input.protocol, baseUrl: input.baseUrl, models: input.models, needsKey: input.needsKey };
    settingsStore.write(listKey, list.map((provider) => (provider.id === providerId ? updated : provider)));
    if (input.apiKey !== undefined) {
      const { [providerId]: _previousKey, ...otherKeys } = readKeys();
      settingsStore.writeSecrets(secretsKey, input.apiKey.trim() ? { ...otherKeys, [providerId]: input.apiKey.trim() } : otherKeys);
    }
    eventHub.publish({ type: "claude_auth_changed" });
    return view(updated);
  },

  remove(providerId: string): void {
    settingsStore.write(listKey, readList().filter((provider) => provider.id !== providerId));
    const { [providerId]: _removedKey, ...otherKeys } = readKeys();
    settingsStore.writeSecrets(secretsKey, otherKeys);
    if (settingsStore.read<string>(activeKey, claudeProviderId) === providerId) settingsStore.write(activeKey, claudeProviderId);
    eventHub.publish({ type: "claude_auth_changed" });
  },

  setActive(providerId: string): void {
    if (providerId !== claudeProviderId && !readList().some((provider) => provider.id === providerId)) throw new Error(t("Anbieter nicht gefunden"));
    settingsStore.write(activeKey, providerId);
    eventHub.publish({ type: "claude_auth_changed" });
  },

  /** Stored key of a provider ("" = none). */
  apiKeyOf: (providerId: string): string => readKeys()[providerId] ?? "",

  /** Process env that points Claude Code at this provider's endpoint (never an Anthropic key). */
  environmentFor(provider: ProviderView, baseEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const { ANTHROPIC_API_KEY: _removedApiKey, ...environment } = baseEnvironment;
    const apiKey = readKeys()[provider.id];
    return {
      ...environment,
      ANTHROPIC_BASE_URL: provider.baseUrl,
      // Local gateways without auth still need a non-empty token.
      ANTHROPIC_AUTH_TOKEN: apiKey || "harnold",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
  },
};

/** Helper models (summaries, subagents) must not ask for Claude models a foreign endpoint doesn't know. */
export function withModelAliases(environment: NodeJS.ProcessEnv, model: string): NodeJS.ProcessEnv {
  if (!environment.ANTHROPIC_BASE_URL) return environment;
  return {
    ...environment,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  };
}

/** Asks an endpoint which models it offers (GET /models); the user can still type ids by hand. */
export async function discoverProviderModels(input: { protocol: ProviderProtocol; baseUrl: string; apiKey: string }): Promise<string[]> {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  await assertAllowedHttpUrl(baseUrl);
  const url = input.protocol === "anthropic" ? `${baseUrl}/v1/models?limit=200` : `${baseUrl}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (input.apiKey) headers["x-api-key"] = input.apiKey;
    if (input.apiKey && !new URL(baseUrl).host.endsWith("anthropic.com")) headers.authorization = `Bearer ${input.apiKey}`;
  } else if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(t("Modelle nicht abrufbar ({0})", response.status));
  const body = (await response.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
  const ids = (body.data ?? []).flatMap((entry) => (entry.id ? [entry.id] : []));
  // Some servers (Gemini native) answer with { models: [{ name: "models/…" }] }.
  const namedIds = (body.models ?? []).flatMap((entry) => (entry.name ? [entry.name.replace(/^models\//, "")] : []));
  const found = [...new Set([...ids, ...namedIds])].sort();
  if (!found.length) throw new Error(t("Der Endpunkt nennt keine Modelle"));
  return found;
}
