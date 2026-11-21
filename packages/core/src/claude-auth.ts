import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { settingsStore } from "./settings.ts";
import { eventHub } from "./events.ts";

/**
 * How the agent talks to Claude:
 * - "subscription": Claude login (Pro/Max/Team or Console) of the bundled Claude Code – shared with `claude` on this machine.
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
};

export const claudeSettingsSchema = z.object({
  mode: z.enum(["subscription", "apiKey"]),
  /** Only sent when changed; "" removes the stored key. */
  apiKey: z.string().optional(),
});

const modeKey = "claude.authMode";
const secretsKey = "claude.secrets";

/** The Claude Code binary bundled with the Agent SDK (falls back to `claude` on PATH). */
function claudeExecutable(): string {
  try {
    const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    const packageJsonPath = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return path.join(path.dirname(packageJsonPath), process.platform === "win32" ? "claude.exe" : "claude");
  } catch {
    return "claude";
  }
}

const runClaude = (args: string[], timeoutMs = 15_000) =>
  new Promise<string>((resolve, reject) => {
    execFile(claudeExecutable(), args, { timeout: timeoutMs, env: environmentWithoutApiKey() }, (runError, standardOutput, standardError) => {
      if (runError) reject(new Error(standardError.trim() || runError.message));
      else resolve(standardOutput);
    });
  });

function environmentWithoutApiKey(): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _removedApiKey, ...environment } = process.env;
  return environment;
}

let cachedAccount: { account: ClaudeAccount | null; cliError?: string; readAt: number } | null = null;

async function readAccount(forceRefresh = false): Promise<{ account: ClaudeAccount | null; cliError?: string }> {
  if (!forceRefresh && cachedAccount && Date.now() - cachedAccount.readAt < 30_000) return cachedAccount;
  try {
    const statusJson = JSON.parse(await runClaude(["auth", "status", "--json"])) as Record<string, unknown>;
    const pickString = (key: string) => (typeof statusJson[key] === "string" ? (statusJson[key] as string) : undefined);
    const account: ClaudeAccount = {
      loggedIn: statusJson.loggedIn === true,
      authMethod: pickString("authMethod"),
      email: pickString("email"),
      orgName: pickString("orgName"),
      subscriptionType: pickString("subscriptionType"),
      apiProvider: pickString("apiProvider"),
    };
    cachedAccount = { account, readAt: Date.now() };
  } catch (statusError) {
    cachedAccount = { account: null, cliError: statusError instanceof Error ? statusError.message : String(statusError), readAt: Date.now() };
  }
  return cachedAccount;
}

const readMode = () => settingsStore.read<ClaudeAuthMode>(modeKey, "subscription");
const readApiKey = () => settingsStore.readSecrets(secretsKey).apiKey || "";

// ---------------------------------------------------------------- Login flow

let pendingLogin: { child: ChildProcessWithoutNullStreams; output: string } | null = null;

function finishLogin(): void {
  pendingLogin = null;
  cachedAccount = null;
  eventHub.publish({ type: "claude_auth_changed" });
}

export const claudeAuth = {
  async status(forceRefresh = false): Promise<ClaudeAuthStatus> {
    const mode = readMode();
    const apiKeySet = Boolean(readApiKey());
    const environmentApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
    const { account, cliError } = await readAccount(forceRefresh);
    const ready = mode === "apiKey" ? apiKeySet || environmentApiKey : Boolean(account?.loggedIn);
    return { mode, apiKeySet, environmentApiKey, account, cliError, loginPending: Boolean(pendingLogin), ready };
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
  startLogin(method: "claudeai" | "console"): Promise<{ url: string }> {
    pendingLogin?.child.kill();
    const child = spawn(claudeExecutable(), ["auth", "login", method === "console" ? "--console" : "--claudeai"], {
      env: { ...environmentWithoutApiKey(), BROWSER: "true" },
    });
    const loginState = { child, output: "" };
    pendingLogin = loginState;
    child.on("exit", () => {
      if (pendingLogin === loginState) finishLogin();
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Keine Anmelde-URL von Claude Code erhalten")), 20_000);
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

  submitLoginCode(code: string): Promise<ClaudeAuthStatus> {
    const loginState = pendingLogin;
    if (!loginState) throw new Error("Keine Anmeldung aktiv – bitte neu starten");
    return new Promise((resolve, reject) => {
      const outputBefore = loginState.output.length;
      const timeout = setTimeout(() => {
        loginState.child.kill();
        reject(new Error("Anmeldung hat zu lange gedauert"));
      }, 60_000);
      loginState.child.once("exit", (exitCode) => {
        clearTimeout(timeout);
        if (exitCode === 0) claudeAuth.status(true).then(resolve, reject);
        else reject(new Error(loginState.output.slice(outputBefore).trim().split("\n").pop() || "Anmeldung fehlgeschlagen"));
      });
      loginState.child.stdin.write(`${code.trim()}\n`);
    });
  },

  cancelLogin(): void {
    pendingLogin?.child.kill();
  },

  async logout(): Promise<ClaudeAuthStatus> {
    await runClaude(["auth", "logout"]);
    cachedAccount = null;
    eventHub.publish({ type: "claude_auth_changed" });
    return claudeAuth.status(true);
  },

  /** Friendly error before a turn when nothing is connected. */
  async assertReady(): Promise<void> {
    const currentStatus = await claudeAuth.status();
    // Unknown CLI state (status failed) is not a reason to block – the SDK reports real auth errors itself.
    if (!currentStatus.ready && !currentStatus.cliError) throw new Error("Claude ist nicht verbunden – Einstellungen → Claude");
  },
};
