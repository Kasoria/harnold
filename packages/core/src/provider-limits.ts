import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProfileForEnvironment, defaultClaudeProfile, type ClaudeProfile } from "./claude-auth.ts";
import { codexSettings } from "./codex-auth.ts";
import { agentBackendSettings } from "./agent-backend-settings.ts";
import { environmentStore } from "./environments.ts";
import { t } from "./i18n.ts";

/** One usage window of a subscription (e.g. the 5-hour session or the week). */
export type LimitWindow = { id: string; label: string; usedPercent: number; resetsAt: number | null };
export type ProviderLimits = {
  /** "claude" | "codex" */
  id: string;
  label: string;
  plan?: string;
  windows: LimitWindow[];
  error?: string;
};
export type LimitsView = { providers: ProviderLimits[]; fetchedAt: number };

const cacheLifetimeMs = 60_000;
const requestTimeoutMs = 10_000;
const cache = new Map<string, { at: number; value: Promise<ProviderLimits | null> }>();

function cached(cacheKey: string, load: () => Promise<ProviderLimits | null>): Promise<ProviderLimits | null> {
  const existing = cache.get(cacheKey);
  if (existing && Date.now() - existing.at < cacheLifetimeMs) return existing.value;
  const value = load();
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

const readJsonFile = (filePath: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" ? (value as Record<string, unknown>) : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(requestTimeoutMs) });
  if (response.status === 401 || response.status === 403) throw new Error(t("Anmeldung abgelaufen – den Agent einmal kurz benutzen oder neu anmelden"));
  if (!response.ok) throw new Error(t("Limits nicht abrufbar ({0})", response.status));
  return response.json();
}

// ---------------------------------------------------------------- Claude

/** macOS keeps the Claude Code login in the keychain instead of a file. */
const readMacKeychain = () =>
  new Promise<unknown>((resolve) => {
    if (process.platform !== "darwin") return resolve(null);
    execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5000 }, (keychainError, standardOutput) => {
      if (keychainError) return resolve(null);
      try {
        resolve(JSON.parse(standardOutput.trim()));
      } catch {
        resolve(null);
      }
    });
  });

async function readClaudeOauth(profile: ClaudeProfile): Promise<{ accessToken: string; expiresAt: number | null; plan?: string } | null> {
  const configDirectory = profile.configDirectory ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const credentials = readJsonFile(path.join(configDirectory, ".credentials.json")) ?? (profile.configDirectory ? null : await readMacKeychain());
  const oauth = asRecord(asRecord(credentials)?.claudeAiOauth);
  if (!oauth || typeof oauth.accessToken !== "string") return null;
  return { accessToken: oauth.accessToken, expiresAt: asNumber(oauth.expiresAt), plan: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined };
}

const claudeWindows: Array<{ key: string; id: string; label: string }> = [
  { key: "five_hour", id: "session", label: "Aktuelle Sitzung" },
  { key: "seven_day", id: "week", label: "Diese Woche" },
  { key: "seven_day_opus", id: "week-opus", label: "Woche · Opus" },
  { key: "seven_day_sonnet", id: "week-sonnet", label: "Woche · Sonnet" },
];

async function loadClaudeLimits(profile: ClaudeProfile): Promise<ProviderLimits | null> {
  const oauth = await readClaudeOauth(profile);
  if (!oauth) return null; // API key or not logged in: there are no subscription limits
  const base = { id: "claude", label: "Claude", plan: oauth.plan };
  if (oauth.expiresAt !== null && oauth.expiresAt < Date.now()) {
    return { ...base, windows: [], error: t("Anmeldung abgelaufen – den Agent einmal kurz benutzen oder neu anmelden") };
  }
  try {
    const body = asRecord(await fetchJson("https://api.anthropic.com/api/oauth/usage", { authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" }));
    const windows: LimitWindow[] = [];
    for (const { key, id, label } of claudeWindows) {
      const entry = asRecord(body?.[key]);
      const utilization = asNumber(entry?.utilization);
      if (!entry || utilization === null) continue;
      const resetsAtMs = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : NaN;
      windows.push({ id, label, usedPercent: Math.min(100, Math.max(0, utilization)), resetsAt: Number.isNaN(resetsAtMs) ? null : resetsAtMs });
    }
    return { ...base, windows };
  } catch (fetchError) {
    return { ...base, windows: [], error: fetchError instanceof Error ? fetchError.message : String(fetchError) };
  }
}

// ---------------------------------------------------------------- Codex

async function loadCodexLimits(): Promise<ProviderLimits | null> {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const tokens = asRecord(asRecord(readJsonFile(path.join(codexHome, "auth.json")))?.tokens);
  if (!tokens || typeof tokens.access_token !== "string") return null; // API key or not logged in
  const base = { id: "codex", label: "Codex" };
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${tokens.access_token}` };
    if (typeof tokens.account_id === "string") headers["chatgpt-account-id"] = tokens.account_id;
    const body = asRecord(await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers));
    const rateLimit = asRecord(body?.rate_limit);
    const windows: LimitWindow[] = [];
    const addWindow = (id: string, fallbackLabel: string, rawWindow: unknown) => {
      const window = asRecord(rawWindow);
      const usedPercent = asNumber(window?.used_percent);
      if (!window || usedPercent === null) return;
      const windowSeconds = asNumber(window.limit_window_seconds);
      const resetAtSeconds = asNumber(window.reset_at);
      const resetAfterSeconds = asNumber(window.reset_after_seconds);
      const label = windowSeconds !== null ? (windowSeconds >= 5 * 24 * 3600 ? "Diese Woche" : "Aktuelle Sitzung") : fallbackLabel;
      windows.push({
        id,
        label,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        resetsAt: resetAtSeconds !== null ? resetAtSeconds * 1000 : resetAfterSeconds !== null ? Date.now() + resetAfterSeconds * 1000 : null,
      });
    };
    addWindow("session", "Aktuelle Sitzung", rateLimit?.primary_window);
    addWindow("week", "Diese Woche", rateLimit?.secondary_window);
    return { ...base, plan: typeof body?.plan_type === "string" ? body.plan_type : undefined, windows };
  } catch (fetchError) {
    return { ...base, windows: [], error: fetchError instanceof Error ? fetchError.message : String(fetchError) };
  }
}

// ---------------------------------------------------------------- Public

export const providerLimits = {
  /** Subscription limits of every connected provider; the active agent comes first. */
  async read(environmentId?: string | null): Promise<LimitsView> {
    if (environmentId) environmentStore.get(environmentId); // throws when unknown
    const profile = environmentId ? claudeProfileForEnvironment(environmentId) : defaultClaudeProfile;
    const [claudeLimits, codexLimits] = await Promise.all([
      cached(`claude:${profile.key}`, () => loadClaudeLimits(profile)),
      codexSettings.mode() === "login" ? cached("codex", loadCodexLimits) : Promise.resolve(null),
    ]);
    const providers = [claudeLimits, codexLimits].filter((entry): entry is ProviderLimits => entry !== null);
    if (agentBackendSettings.read() === "codex") providers.reverse();
    return { providers, fetchedAt: Date.now() };
  },
};
