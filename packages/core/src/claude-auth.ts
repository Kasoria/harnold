import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.ts";
import { z } from "zod";
import { settingsStore } from "./settings.ts";
import { eventHub } from "./events.ts";
import { agentRuntimes, type AgentRuntimeStatus } from "./agent-runtimes.ts";
import { t } from "./i18n.ts";

/**
 * How the agent talks to Claude:
 * - "subscription": Claude login (Pro/Max/Team or Console) of Claude Code – shared with `claude` on this machine.
 * - "apiKey": an Anthropic API key stored (encrypted) in Harnold.
 */
export type ClaudeAuthMode = "subscription" | "apiKey";
export type ClaudeAccount = {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  apiProvider?: string;
};
export type ClaudeAuthStatus = {
  mode: ClaudeAuthMode;
  apiKeySet: boolean;
  environmentApiKey: boolean;
  account: ClaudeAccount | null;
  cliError?: string;
  loginPending: boolean;
  ready: boolean;
  /** The Claude Code program on this machine (needed for both modes). */
  runtime: AgentRuntimeStatus;
};

export const claudeSettingsSchema = z.object({
  mode: z.enum(["subscription", "apiKey"]),
  /** Only sent when changed; "" removes the stored key. */
  apiKey: z.string().optional(),
});

/**
 * Which Claude Code login to use. "default" = the machine's normal login (~/.claude). Environments with their own
 * Claude account get a separate config directory, so their login never touches the default one.
 */
export type ClaudeProfile = { key: string; configDirectory?: string };
export const defaultClaudeProfile: ClaudeProfile = { key: "default" };

/** Files shared from ~/.claude into an environment's config dir, so skills, CLAUDE.md and settings keep working. */
const sharedUserEntries = ["CLAUDE.md", "settings.json", "skills", "agents", "commands", "plugins"];

export function claudeProfileForEnvironment(environmentId: string): ClaudeProfile {
  const configDirectory = path.join(config.dataDirectory, "claude-accounts", environmentId);
  fs.mkdirSync(configDirectory, { recursive: true });
  const userConfigDirectory = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  for (const entryName of sharedUserEntries) {
    const sourcePath = path.join(userConfigDirectory, entryName);
    const linkPath = path.join(configDirectory, entryName);
    try {
      if (fs.existsSync(sourcePath) && !fs.lstatSync(linkPath, { throwIfNoEntry: false })) fs.symlinkSync(sourcePath, linkPath);
    } catch {
      /* sharing is best effort */
    }
  }
  return { key: environmentId, configDirectory };
}

export function removeClaudeProfile(environmentId: string): void {
  fs.rmSync(path.join(config.dataDirectory, "claude-accounts", environmentId), { recursive: true, force: true });
}

const modeKey = "claude.authMode";
const defaultModelKey = "claude.defaultModel";

/** Workspace default model – concrete, never "whatever Claude Code picks". Environments and the composer may override it. */
export const agentModelSettings = {
  read: (): string => settingsStore.read<string>(defaultModelKey, config.defaultModel ?? "claude-opus-5-5"),
  write: (model: string): string => {
    settingsStore.write(defaultModelKey, model);
    return model;
  },
};
const secretsKey = "claude.secrets";

/** Claude Code to start (system install, SDK copy or Harnold download – see agent-runtimes). */
export async function claudeExecutable(): Promise<string> {
  const executablePath = await agentRuntimes.executable("claude-code");
  if (!executablePath) throw new Error(t("Claude Code ist nicht installiert – Einstellungen → Claude"));
  return executablePath;
}

/** Env for Claude Code with this profile's login (never an API key). */
export function subscriptionEnvironment(profile: ClaudeProfile): NodeJS.ProcessEnv {
  return profile.configDirectory ? { ...environmentWithoutApiKey(), CLAUDE_CONFIG_DIR: profile.configDirectory } : environmentWithoutApiKey();
}

const runClaude = async (args: string[], profile: ClaudeProfile, timeoutMs = 15_000) => {
  const executablePath = await claudeExecutable();
  return new Promise<string>((resolve, reject) => {
    execFile(executablePath, args, { timeout: timeoutMs, env: subscriptionEnvironment(profile) }, (runError, standardOutput, standardError) => {
      // `auth status --json` exits non-zero when logged out but still prints the status.
      if (runError && !standardOutput.trim().startsWith("{")) reject(new Error(standardError.trim() || runError.message));
      else resolve(standardOutput);
    });
  });
};

function environmentWithoutApiKey(): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _removedApiKey, ...environment } = process.env;
  return environment;
}

type CachedAccount = { account: ClaudeAccount | null; cliError?: string; readAt: number };
const cachedAccounts = new Map<string, CachedAccount>();

async function readAccount(profile: ClaudeProfile, forceRefresh = false): Promise<{ account: ClaudeAccount | null; cliError?: string }> {
  const cachedAccount = cachedAccounts.get(profile.key);
  if (!forceRefresh && cachedAccount && Date.now() - cachedAccount.readAt < 30_000) return cachedAccount;
  let freshAccount: CachedAccount;
  try {
    const statusJson = JSON.parse(await runClaude(["auth", "status", "--json"], profile)) as Record<string, unknown>;
    const pickString = (key: string) => (typeof statusJson[key] === "string" ? (statusJson[key] as string) : undefined);
    const account: ClaudeAccount = {
      loggedIn: statusJson.loggedIn === true,
      authMethod: pickString("authMethod"),
      email: pickString("email"),
      orgName: pickString("orgName"),
      subscriptionType: pickString("subscriptionType"),
      apiProvider: pickString("apiProvider"),
    };
    freshAccount = { account, readAt: Date.now() };
  } catch (statusError) {
    freshAccount = { account: null, cliError: statusError instanceof Error ? statusError.message : String(statusError), readAt: Date.now() };
  }
  cachedAccounts.set(profile.key, freshAccount);
  return freshAccount;
}

const readMode = () => settingsStore.read<ClaudeAuthMode>(modeKey, "subscription");
const readApiKey = () => settingsStore.readSecrets(secretsKey).apiKey || "";

// ---------------------------------------------------------------- Login flow

type PendingLogin = { child: ChildProcessWithoutNullStreams; output: string };
const pendingLogins = new Map<string, PendingLogin>();

function finishLogin(profile: ClaudeProfile): void {
  pendingLogins.delete(profile.key);
  cachedAccounts.delete(profile.key);
  eventHub.publish({ type: "claude_auth_changed" });
}

export const claudeAuth = {
  /** Default profile: the workspace setting (Claude account or API key). Other profiles: their Claude login only. */
  async status(forceRefresh = false, profile: ClaudeProfile = defaultClaudeProfile): Promise<ClaudeAuthStatus> {
    const isDefault = profile.key === defaultClaudeProfile.key;
    const mode = isDefault ? readMode() : "subscription";
    const apiKeySet = isDefault && Boolean(readApiKey());
    const environmentApiKey = isDefault && Boolean(process.env.ANTHROPIC_API_KEY);
    const runtime = await agentRuntimes.status("claude-code", forceRefresh);
    const { account, cliError } = runtime.found ? await readAccount(profile, forceRefresh) : { account: null, cliError: undefined };
    const credentialsReady = mode === "apiKey" ? apiKeySet || environmentApiKey : Boolean(account?.loggedIn);
    return { mode, apiKeySet, environmentApiKey, account, cliError, loginPending: pendingLogins.has(profile.key), ready: runtime.found && credentialsReady, runtime };
  },

  async save(input: z.infer<typeof claudeSettingsSchema>): Promise<ClaudeAuthStatus> {
    settingsStore.write(modeKey, input.mode);
    if (input.apiKey !== undefined) settingsStore.writeSecrets(secretsKey, input.apiKey.trim() ? { apiKey: input.apiKey.trim() } : {});
    eventHub.publish({ type: "claude_auth_changed" });
    return claudeAuth.status();
  },

  /** Env for `query()`: the chosen credential wins, the other one is removed. */
  agentEnvironment(): NodeJS.ProcessEnv {
    if (readMode() === "subscription") return environmentWithoutApiKey();
    const storedApiKey = readApiKey();
    return storedApiKey ? { ...process.env, ANTHROPIC_API_KEY: storedApiKey } : { ...process.env };
  },

  /** Starts `claude auth login` and returns the sign-in URL. The page then shows a code for `submitLoginCode`. */
  async startLogin(method: "claudeai" | "console", profile: ClaudeProfile = defaultClaudeProfile): Promise<{ url: string }> {
    pendingLogins.get(profile.key)?.child.kill();
    const child = spawn(await claudeExecutable(), ["auth", "login", method === "console" ? "--console" : "--claudeai"], {
      env: { ...subscriptionEnvironment(profile), BROWSER: "true" },
    });
    const loginState: PendingLogin = { child, output: "" };
    pendingLogins.set(profile.key, loginState);
    child.on("exit", () => {
      if (pendingLogins.get(profile.key) === loginState) finishLogin(profile);
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(t("Keine Anmelde-URL von Claude Code erhalten"))), 20_000);
      const handleOutput = (chunk: Buffer) => {
        loginState.output += chunk.toString();
        const urlMatch = loginState.output.match(/https:\/\/\S+/);
        if (urlMatch) {
          clearTimeout(timeout);
          resolve({ url: urlMatch[0] });
        }
      };
      child.stdout.on("data", handleOutput);
      child.stderr.on("data", handleOutput);
      child.on("error", (spawnError) => {
        clearTimeout(timeout);
        reject(spawnError);
      });
    });
  },

  submitLoginCode(code: string, profile: ClaudeProfile = defaultClaudeProfile): Promise<ClaudeAuthStatus> {
    const loginState = pendingLogins.get(profile.key);
    if (!loginState) throw new Error(t("Keine Anmeldung aktiv – bitte neu starten"));
    return new Promise((resolve, reject) => {
      const outputBefore = loginState.output.length;
      const timeout = setTimeout(() => {
        loginState.child.kill();
        reject(new Error(t("Anmeldung hat zu lange gedauert")));
      }, 60_000);
      loginState.child.once("exit", (exitCode) => {
        clearTimeout(timeout);
        if (exitCode === 0) claudeAuth.status(true, profile).then(resolve, reject);
        else reject(new Error(loginState.output.slice(outputBefore).trim().split("\n").pop() || "Anmeldung fehlgeschlagen"));
      });
      loginState.child.stdin.write(`${code.trim()}\n`);
    });
  },

  cancelLogin(profile: ClaudeProfile = defaultClaudeProfile): void {
    pendingLogins.get(profile.key)?.child.kill();
  },

  async logout(profile: ClaudeProfile = defaultClaudeProfile): Promise<ClaudeAuthStatus> {
    await runClaude(["auth", "logout"], profile);
    cachedAccounts.delete(profile.key);
    eventHub.publish({ type: "claude_auth_changed" });
    return claudeAuth.status(true, profile);
  },

  /** Friendly error before a turn when nothing is connected. */
  async assertReady(): Promise<void> {
    const currentStatus = await claudeAuth.status();
    if (!currentStatus.runtime.found) throw new Error(t("Claude Code ist nicht installiert – Einstellungen → Claude"));
    // Unknown CLI state (status failed) is not a reason to block – the SDK reports real auth errors itself.
    if (!currentStatus.ready && !currentStatus.cliError) throw new Error(t("Claude ist nicht verbunden – Einstellungen → Claude"));
  },
};
