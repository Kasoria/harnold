import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { settingsStore } from "./settings.ts";
import { eventHub } from "./events.ts";
import { agentRuntimes, type AgentRuntimeStatus } from "./agent-runtimes.ts";
import { t } from "./i18n.ts";

/**
 * How Codex signs in: "login" = the ChatGPT/OpenAI login of the codex program on this machine (~/.codex),
 * "apiKey" = an OpenAI API key stored (encrypted) in Harnold.
 */
export type CodexAuthMode = "login" | "apiKey";
export type CodexAuthStatus = {
  mode: CodexAuthMode;
  apiKeySet: boolean;
  environmentApiKey: boolean;
  /** Text of `codex login status` when signed in (e.g. "Logged in using ChatGPT"). */
  loginText: string | null;
  loggedIn: boolean;
  loginPending: boolean;
  ready: boolean;
  runtime: AgentRuntimeStatus;
};

const modeKey = "codex.authMode";
const secretsKey = "codex.secrets";
const modelsKey = "codex.models";
const defaultModelKey = "codex.defaultModel";

/** Marker for "let Codex choose its own default model". */
export const codexDefaultModel = "codex-default";

export const codexSettings = {
  mode: (): CodexAuthMode => settingsStore.read<CodexAuthMode>(modeKey, "login"),
  apiKey: (): string => settingsStore.readSecrets(secretsKey).apiKey || "",
  /** Model ids offered in pickers; the Codex default is always first. */
  models: (): string[] => settingsStore.read<string[]>(modelsKey, []),
  defaultModel: (): string => settingsStore.read<string>(defaultModelKey, codexDefaultModel),
  writeDefaultModel: (model: string): string => {
    settingsStore.write(defaultModelKey, model);
    return model;
  },
};

const runCodex = (executablePath: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ output: string; failed: boolean }>((resolve) => {
    execFile(executablePath, args, { timeout: 15_000, env }, (runError, standardOutput, standardError) =>
      resolve({ output: `${standardOutput}${standardError}`.trim(), failed: Boolean(runError) }),
    );
  });

type PendingLogin = { child: ChildProcessWithoutNullStreams; output: string };
let pendingLogin: PendingLogin | null = null;

export async function codexExecutable(): Promise<string> {
  const executablePath = await agentRuntimes.executable("codex");
  if (!executablePath) throw new Error(t("Codex ist nicht installiert – Einstellungen → Agent"));
  return executablePath;
}

export const codexAuth = {
  async status(forceRefresh = false): Promise<CodexAuthStatus> {
    const mode = codexSettings.mode();
    const apiKeySet = Boolean(codexSettings.apiKey());
    const environmentApiKey = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
    const runtime = await agentRuntimes.status("codex", forceRefresh);
    let loginText: string | null = null;
    let loggedIn = false;
    if (runtime.found && runtime.executablePath) {
      const loginStatus = await runCodex(runtime.executablePath, ["login", "status"], process.env);
      loggedIn = !loginStatus.failed && !/not logged in/i.test(loginStatus.output);
      loginText = loggedIn ? loginStatus.output.split("\n")[0] || null : null;
    }
    const credentialsReady = mode === "apiKey" ? apiKeySet || environmentApiKey : loggedIn;
    return { mode, apiKeySet, environmentApiKey, loginText, loggedIn, loginPending: pendingLogin !== null, ready: runtime.found && credentialsReady, runtime };
  },

  async save(input: { mode: CodexAuthMode; apiKey?: string; models?: string[] }): Promise<CodexAuthStatus> {
    settingsStore.write(modeKey, input.mode);
    if (input.apiKey !== undefined) settingsStore.writeSecrets(secretsKey, input.apiKey.trim() ? { apiKey: input.apiKey.trim() } : {});
    if (input.models) settingsStore.write(modelsKey, [...new Set(input.models.map((model) => model.trim()).filter(Boolean))]);
    eventHub.publish({ type: "claude_auth_changed" });
    return codexAuth.status();
  },

  /** Env for the Codex program: the chosen credential wins, the other one is removed. */
  agentEnvironment(): NodeJS.ProcessEnv {
    const { OPENAI_API_KEY: _openaiKey, CODEX_API_KEY: _codexKey, ...environment } = process.env;
    if (codexSettings.mode() === "login") return environment;
    const apiKey = codexSettings.apiKey() || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
    return apiKey ? { ...environment, CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey } : environment;
  },

  /** Starts `codex login` (browser sign-in with ChatGPT) and returns the sign-in URL; the program finishes the login itself. */
  async startLogin(): Promise<{ url: string }> {
    pendingLogin?.child.kill();
    const child = spawn(await codexExecutable(), ["login"], { env: { ...codexAuth.agentEnvironment(), BROWSER: "true" } });
    const loginState: PendingLogin = { child, output: "" };
    pendingLogin = loginState;
    child.on("exit", () => {
      if (pendingLogin === loginState) pendingLogin = null;
      eventHub.publish({ type: "claude_auth_changed" });
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(t("Keine Anmelde-URL von Codex erhalten"))), 20_000);
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

  cancelLogin(): void {
    pendingLogin?.child.kill();
  },

  async logout(): Promise<CodexAuthStatus> {
    await runCodex(await codexExecutable(), ["logout"], process.env);
    eventHub.publish({ type: "claude_auth_changed" });
    return codexAuth.status(true);
  },

  async assertReady(): Promise<void> {
    const currentStatus = await codexAuth.status();
    if (!currentStatus.runtime.found) throw new Error(t("Codex ist nicht installiert – Einstellungen → Agent"));
    if (!currentStatus.ready) throw new Error(t("Codex ist nicht angemeldet – Einstellungen → Agent"));
  },
};
