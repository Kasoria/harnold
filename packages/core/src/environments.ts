import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database, projectStore } from "./db.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import { eventHub } from "./events.ts";
import { claudeAuth, claudeProfileForEnvironment, removeClaudeProfile, subscriptionEnvironment } from "./claude-auth.ts";
import { checkProviderAccount, detectGitIdentity, environmentProviders, findProvider, type AccountCheck } from "./environment-providers.ts";

/**
 * Environments bundle accounts (any provider from the catalog), git identity, AI settings and variables. A project belongs to at most one
 * environment; every agent turn in that project runs with its credentials – no CLI re-login, no switching.
 */
database.exec(`
  CREATE TABLE IF NOT EXISTS environments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    git_name TEXT NOT NULL DEFAULT '',
    git_email TEXT NOT NULL DEFAULT '',
    ssh_key_path TEXT NOT NULL DEFAULT '',
    secrets TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS environment_projects (
    project_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE
  );
`);

// Added later: AI per environment.
for (const columnDefinition of ["claude_mode TEXT NOT NULL DEFAULT 'inherit'", "model TEXT NOT NULL DEFAULT ''"]) {
  try {
    database.exec(`ALTER TABLE environments ADD COLUMN ${columnDefinition}`);
  } catch {
    /* column exists */
  }
}

/** "inherit" = Einstellungen → Claude; "subscription" = own Claude login of this environment; "apiKey" = own key. */
export type EnvironmentClaudeMode = "inherit" | "subscription" | "apiKey";

const variableKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const environmentInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  gitName: z.string().trim(),
  gitEmail: z.string().trim(),
  sshKeyPath: z.string().trim(),
  /** Accounts by provider; listed accounts replace the stored list. An empty secret value keeps the stored one. */
  accounts: z.array(z.object({ provider: z.string(), values: z.record(z.string(), z.string()) })).default([]),
  claudeMode: z.enum(["inherit", "subscription", "apiKey"]).default("inherit"),
  claudeApiKey: z.string().optional(),
  /** Default model for turns in this environment; "" = Harnold default. The composer's explicit choice wins. */
  model: z.string().trim().default(""),
  /** Secret variables with an empty value keep their stored value. */
  variables: z.array(z.object({ key: z.string().regex(variableKeyPattern, "Variablenname: Buchstaben, Ziffern, _"), value: z.string(), secret: z.boolean() })),
  projectIds: z.array(z.string()),
});
export type EnvironmentInput = z.infer<typeof environmentInputSchema>;

type StoredAccount = { provider: string; values: Record<string, string> };
type StoredSecrets = { accounts: StoredAccount[]; claudeApiKey?: string; variables: { key: string; value: string; secret: boolean }[] };
/** Shape before accounts became generic. */
type LegacySecrets = Partial<StoredSecrets> & { githubToken?: string; vercelToken?: string };

/** Account as sent out: secret values are "", `setKeys` says which fields hold a value. */
export type EnvironmentAccount = { provider: string; label: string; values: Record<string, string>; setKeys: string[] };

export type Environment = {
  id: string;
  name: string;
  gitName: string;
  gitEmail: string;
  sshKeyPath: string;
  accounts: EnvironmentAccount[];
  claudeMode: EnvironmentClaudeMode;
  claudeApiKeySet: boolean;
  model: string;
  /** Secret values are never sent out (value ""). */
  variables: { key: string; value: string; secret: boolean }[];
  projectIds: string[];
  createdAt: number;
};

type Row = Record<string, unknown>;

function readSecrets(row: Row): StoredSecrets {
  const stored: LegacySecrets = row.secrets ? JSON.parse(decryptSecret(String(row.secrets))) : {};
  const accounts = [...(stored.accounts ?? [])];
  if (stored.githubToken && !accounts.some((account) => account.provider === "github")) accounts.push({ provider: "github", values: { GH_TOKEN: stored.githubToken } });
  if (stored.vercelToken && !accounts.some((account) => account.provider === "vercel")) accounts.push({ provider: "vercel", values: { VERCEL_TOKEN: stored.vercelToken } });
  return { accounts, claudeApiKey: stored.claudeApiKey, variables: stored.variables ?? [] };
}

const isSecretField = (providerId: string, key: string) => findProvider(providerId)?.fields.find((providerField) => providerField.key === key)?.secret ?? true;

function presentAccount(account: StoredAccount): EnvironmentAccount {
  const values = Object.fromEntries(Object.entries(account.values).map(([key, value]) => [key, isSecretField(account.provider, key) ? "" : value]));
  return { provider: account.provider, label: findProvider(account.provider)?.label ?? account.provider, values, setKeys: Object.keys(account.values).filter((key) => account.values[key]) };
}
const projectIdsOf = (environmentId: string) =>
  database.prepare("SELECT project_id FROM environment_projects WHERE environment_id = ?").all(environmentId).map((row) => String(row.project_id));

function present(row: Row): Environment {
  const secrets = readSecrets(row);
  return {
    id: String(row.id),
    name: String(row.name),
    gitName: String(row.git_name),
    gitEmail: String(row.git_email),
    sshKeyPath: String(row.ssh_key_path),
    accounts: secrets.accounts.map(presentAccount),
    claudeMode: (String(row.claude_mode || "inherit") as EnvironmentClaudeMode),
    claudeApiKeySet: Boolean(secrets.claudeApiKey),
    model: String(row.model ?? ""),
    variables: secrets.variables.map((variable) => ({ ...variable, value: variable.secret ? "" : variable.value })),
    projectIds: projectIdsOf(String(row.id)),
    createdAt: Number(row.created_at),
  };
}

const readRow = (environmentId: string) => database.prepare("SELECT * FROM environments WHERE id = ?").get(environmentId);

function requireRow(environmentId: string): Row {
  const row = readRow(environmentId);
  if (!row) throw new Error("Umgebung nicht gefunden");
  return row;
}

function mergeSecrets(previous: StoredSecrets, input: EnvironmentInput): StoredSecrets {
  const keepOrReplace = (previousValue: string | undefined, nextValue: string | undefined) => (nextValue === undefined ? previousValue : nextValue.trim() || undefined);
  const seenKeys = new Set<string>();
  const variables = input.variables.flatMap((variable) => {
    if (seenKeys.has(variable.key)) return [];
    seenKeys.add(variable.key);
    const previousVariable = previous.variables.find((stored) => stored.key === variable.key);
    const value = variable.secret && !variable.value && previousVariable?.secret ? previousVariable.value : variable.value;
    return [{ key: variable.key, value, secret: variable.secret }];
  });
  const seenProviders = new Set<string>();
  const accounts = input.accounts.flatMap((account) => {
    if (seenProviders.has(account.provider)) return [];
    seenProviders.add(account.provider);
    const previousValues = previous.accounts.find((stored) => stored.provider === account.provider)?.values ?? {};
    const values = Object.fromEntries(
      Object.entries({ ...previousValues, ...account.values }).flatMap(([key, value]) => {
        const nextValue = isSecretField(account.provider, key) && !account.values[key]?.trim() ? previousValues[key] : account.values[key] ?? previousValues[key];
        return nextValue?.trim() ? [[key, nextValue.trim()]] : [];
      }),
    );
    return [{ provider: account.provider, values }];
  });
  return {
    accounts,
    claudeApiKey: keepOrReplace(previous.claudeApiKey, input.claudeApiKey),
    variables,
  };
}

function writeProjects(environmentId: string, projectIds: string[]): void {
  database.prepare("DELETE FROM environment_projects WHERE environment_id = ?").run(environmentId);
  const upsert = database.prepare(
    "INSERT INTO environment_projects (project_id, environment_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET environment_id = excluded.environment_id",
  );
  for (const projectId of new Set(projectIds)) if (projectStore.get(projectId)) upsert.run(projectId, environmentId);
}

const publishChange = () => eventHub.publish({ type: "environments_changed" });

/** Git credential helper that answers github.com HTTPS requests with the environment's token (replaces keychain/gh helpers). */
const githubCredentialHelper = `!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f`;

export const environmentStore = {
  list(): Environment[] {
    return database.prepare("SELECT * FROM environments ORDER BY created_at").all().map(present);
  },

  get(environmentId: string): Environment {
    return present(requireRow(environmentId));
  },

  create(input: EnvironmentInput): Environment {
    const environmentId = randomUUID();
    database
      .prepare("INSERT INTO environments (id, name, git_name, git_email, ssh_key_path, secrets, claude_mode, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(environmentId, input.name, input.gitName, input.gitEmail, input.sshKeyPath, encryptSecret(JSON.stringify(mergeSecrets({ accounts: [], variables: [] }, input))), input.claudeMode, input.model, Date.now());
    writeProjects(environmentId, input.projectIds);
    publishChange();
    return environmentStore.get(environmentId);
  },

  update(environmentId: string, input: EnvironmentInput): Environment {
    const row = requireRow(environmentId);
    database
      .prepare("UPDATE environments SET name = ?, git_name = ?, git_email = ?, ssh_key_path = ?, secrets = ?, claude_mode = ?, model = ? WHERE id = ?")
      .run(input.name, input.gitName, input.gitEmail, input.sshKeyPath, encryptSecret(JSON.stringify(mergeSecrets(readSecrets(row), input))), input.claudeMode, input.model, environmentId);
    writeProjects(environmentId, input.projectIds);
    publishChange();
    return environmentStore.get(environmentId);
  },

  remove(environmentId: string): void {
    database.prepare("DELETE FROM environment_projects WHERE environment_id = ?").run(environmentId);
    database.prepare("DELETE FROM environments WHERE id = ?").run(environmentId);
    removeClaudeProfile(environmentId);
    publishChange();
  },

  /** Moves a project into an environment (null = none). */
  assignProject(projectId: string, environmentId: string | null): void {
    if (environmentId) {
      requireRow(environmentId);
      database
        .prepare("INSERT INTO environment_projects (project_id, environment_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET environment_id = excluded.environment_id")
        .run(projectId, environmentId);
    } else database.prepare("DELETE FROM environment_projects WHERE project_id = ?").run(projectId);
    publishChange();
  },

  forProject(projectId: string): Environment | null {
    const row = database.prepare("SELECT environment_id FROM environment_projects WHERE project_id = ?").get(projectId);
    return row ? environmentStore.get(String(row.environment_id)) : null;
  },

  /** Process env for agent turns in this project; empty when it has no environment. */
  variablesForProject(projectId: string): Record<string, string> {
    const assignment = database.prepare("SELECT environment_id FROM environment_projects WHERE project_id = ?").get(projectId);
    const row = assignment && readRow(String(assignment.environment_id));
    if (!row) return {};
    const secrets = readSecrets(row);
    const variables: Record<string, string> = {};
    for (const account of secrets.accounts) {
      const aliases = findProvider(account.provider)?.aliases ?? {};
      for (const [key, value] of Object.entries(account.values)) {
        variables[key] = value;
        for (const alias of aliases[key] ?? []) variables[alias] = value;
      }
    }
    if (variables.GH_TOKEN) {
      // git push/pull over HTTPS: drop other helpers (keychain, gh) and answer with the token.
      Object.assign(variables, {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_1: githubCredentialHelper,
      });
    }
    const gitName = String(row.git_name);
    const gitEmail = String(row.git_email);
    if (gitName) Object.assign(variables, { GIT_AUTHOR_NAME: gitName, GIT_COMMITTER_NAME: gitName });
    if (gitEmail) Object.assign(variables, { GIT_AUTHOR_EMAIL: gitEmail, GIT_COMMITTER_EMAIL: gitEmail });
    const sshKeyPath = String(row.ssh_key_path);
    if (sshKeyPath) variables.GIT_SSH_COMMAND = `ssh -i '${sshKeyPath.replace(/'/g, "'\\''")}' -o IdentitiesOnly=yes`;
    for (const variable of secrets.variables) variables[variable.key] = variable.value;
    return variables;
  },

  /**
   * Everything an agent turn in this project needs from its environment: process env (Claude credentials +
   * accounts + variables) and the default model. Throws a friendly error when the chosen Claude access is missing.
   */
  async agentSetupFor(projectId: string): Promise<{ env: NodeJS.ProcessEnv; model?: string }> {
    const environment = environmentStore.forProject(projectId);
    const variables = environmentStore.variablesForProject(projectId);
    const model = environment?.model || undefined;
    if (!environment || environment.claudeMode === "inherit") {
      await claudeAuth.assertReady();
      const env: NodeJS.ProcessEnv = { ...claudeAuth.agentEnvironment(), ...variables };
      // The workspace setting decides the credential; variables must not sneak in another one.
      const workspaceEnv = claudeAuth.agentEnvironment();
      if (workspaceEnv.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = workspaceEnv.ANTHROPIC_API_KEY;
      else delete env.ANTHROPIC_API_KEY;
      return { env, model };
    }
    if (environment.claudeMode === "apiKey") {
      const claudeApiKey = readSecrets(requireRow(environment.id)).claudeApiKey;
      if (!claudeApiKey) throw new Error(`Umgebung „${environment.name}“: kein Claude-API-Key hinterlegt – Umgebungen → ${environment.name}`);
      return { env: { ...process.env, ...variables, ANTHROPIC_API_KEY: claudeApiKey }, model };
    }
    const profile = claudeProfileForEnvironment(environment.id);
    const accountStatus = await claudeAuth.status(false, profile);
    if (!accountStatus.ready && !accountStatus.cliError) throw new Error(`Umgebung „${environment.name}“: Claude-Konto nicht angemeldet – Umgebungen → ${environment.name}`);
    const env: NodeJS.ProcessEnv = { ...subscriptionEnvironment(profile), ...variables, CLAUDE_CONFIG_DIR: profile.configDirectory };
    delete env.ANTHROPIC_API_KEY;
    return { env, model };
  },

  /** Short note for the system prompt: which accounts are active (never values). */
  contextFor(projectId: string): string {
    const environment = environmentStore.forProject(projectId);
    if (!environment) return "";
    const accounts = [
      ...environment.accounts.map((account) => `${account.label} (${account.setKeys.join(", ")}${account.provider === "github" ? ", git über HTTPS" : ""})`),
      environment.sshKeyPath && "SSH-Key für git",
    ].filter(Boolean);
    return [
      `Umgebung „${environment.name}“ ist aktiv. Ihre Konten und Variablen sind in der Shell bereits gesetzt – nicht umloggen (kein \`gh auth switch\`, \`vercel login\` o. Ä.); CLIs nutzen die Env-Variablen.`,
      accounts.length ? `Konten: ${accounts.join(", ")}.` : "",
      environment.gitName || environment.gitEmail ? `Git-Identität: ${[environment.gitName, environment.gitEmail && `<${environment.gitEmail}>`].filter(Boolean).join(" ")}.` : "",
      environment.variables.length ? `Variablen: ${environment.variables.map((variable) => variable.key).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },

  /** Asks each provider (where possible) who the stored credentials belong to. */
  async checkAccounts(environmentId: string): Promise<Record<string, AccountCheck>> {
    const secrets = readSecrets(requireRow(environmentId));
    const results = await Promise.all(
      secrets.accounts.map(async (account) => {
        const provider = findProvider(account.provider);
        return [account.provider, provider ? await checkProviderAccount(provider, account.values) : undefined] as const;
      }),
    );
    return Object.fromEntries(results.filter((entry): entry is readonly [string, AccountCheck] => Boolean(entry[1])));
  },

  /**
   * Partial change (used by the agent): only given fields change, accounts/variables are merged by provider/key.
   * Without environmentId a new environment is created.
   */
  save(environmentId: string | undefined, patch: EnvironmentPatch): Environment {
    const current = environmentId ? environmentStore.get(environmentId) : null;
    const removedProviders = new Set(patch.removeAccounts ?? []);
    const accounts = (current?.accounts ?? []).filter((account) => !removedProviders.has(account.provider)).map((account) => ({ provider: account.provider, values: {} as Record<string, string> }));
    for (const [provider, values] of Object.entries(patch.accounts ?? {})) {
      const existing = accounts.find((account) => account.provider === provider);
      if (existing) Object.assign(existing.values, values);
      else accounts.push({ provider, values: { ...values } });
    }
    const removedVariables = new Set(patch.removeVariables ?? []);
    const variables = (current?.variables ?? []).filter((variable) => !removedVariables.has(variable.key));
    for (const variable of patch.variables ?? []) {
      const existingIndex = variables.findIndex((existing) => existing.key === variable.key);
      if (existingIndex >= 0) variables[existingIndex] = variable;
      else variables.push(variable);
    }
    const input = environmentInputSchema.parse({
      name: patch.name ?? current?.name ?? "Neue Umgebung",
      gitName: patch.gitName ?? current?.gitName ?? "",
      gitEmail: patch.gitEmail ?? current?.gitEmail ?? "",
      sshKeyPath: patch.sshKeyPath ?? current?.sshKeyPath ?? "",
      accounts,
      claudeMode: patch.claudeMode ?? current?.claudeMode ?? "inherit",
      claudeApiKey: patch.claudeApiKey,
      model: patch.model ?? current?.model ?? "",
      variables,
      projectIds: [...new Set([...(current?.projectIds ?? []), ...(patch.addProjectIds ?? [])])].filter((projectId) => !(patch.removeProjectIds ?? []).includes(projectId)),
    });
    return current ? environmentStore.update(current.id, input) : environmentStore.create(input);
  },

  /** Takes the logins active on this machine (CLIs, config files, env, git config) into an environment. */
  async importCurrent(environmentId: string | undefined, options: { name?: string; providerIds?: string[]; addProjectIds?: string[] }): Promise<{ environment: Environment; found: string[]; notFound: string[] }> {
    const candidates = environmentProviders.filter((provider) => provider.detect && (!options.providerIds?.length || options.providerIds.includes(provider.id)));
    const detected = await Promise.all(candidates.map(async (provider) => [provider, await provider.detect!().catch(() => null)] as const));
    const accounts = Object.fromEntries(detected.flatMap(([provider, values]) => (values ? [[provider.id, values]] : [])));
    const gitIdentity = await detectGitIdentity();
    const current = environmentId ? environmentStore.get(environmentId) : null;
    const environment = environmentStore.save(environmentId, {
      name: options.name,
      gitName: current?.gitName || gitIdentity.gitName || undefined,
      gitEmail: current?.gitEmail || gitIdentity.gitEmail || undefined,
      accounts,
      addProjectIds: options.addProjectIds,
    });
    return {
      environment,
      found: detected.filter(([, values]) => values).map(([provider]) => provider.label),
      notFound: detected.filter(([, values]) => !values).map(([provider]) => provider.label),
    };
  },

};

export type EnvironmentPatch = {
  name?: string;
  gitName?: string;
  gitEmail?: string;
  sshKeyPath?: string;
  /** provider id → field values (merged into the stored account). */
  accounts?: Record<string, Record<string, string>>;
  removeAccounts?: string[];
  claudeMode?: EnvironmentClaudeMode;
  claudeApiKey?: string;
  model?: string;
  variables?: { key: string; value: string; secret: boolean }[];
  removeVariables?: string[];
  addProjectIds?: string[];
  removeProjectIds?: string[];
};
