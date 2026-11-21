import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database, projectStore } from "./db.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import { eventHub } from "./events.ts";

/**
 * Environments bundle accounts (GitHub, Vercel), git identity and variables. A project belongs to at most one
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

const variableKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const environmentInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  gitName: z.string().trim(),
  gitEmail: z.string().trim(),
  sshKeyPath: z.string().trim(),
  /** undefined keeps the stored token, "" removes it. */
  githubToken: z.string().optional(),
  vercelToken: z.string().optional(),
  /** Secret variables with an empty value keep their stored value. */
  variables: z.array(z.object({ key: z.string().regex(variableKeyPattern, "Variablenname: Buchstaben, Ziffern, _"), value: z.string(), secret: z.boolean() })),
  projectIds: z.array(z.string()),
});
export type EnvironmentInput = z.infer<typeof environmentInputSchema>;

type StoredSecrets = { githubToken?: string; vercelToken?: string; variables: { key: string; value: string; secret: boolean }[] };

export type Environment = {
  id: string;
  name: string;
  gitName: string;
  gitEmail: string;
  sshKeyPath: string;
  githubTokenSet: boolean;
  vercelTokenSet: boolean;
  /** Secret values are never sent out (value ""). */
  variables: { key: string; value: string; secret: boolean }[];
  projectIds: string[];
  createdAt: number;
};

type Row = Record<string, unknown>;

const readSecrets = (row: Row): StoredSecrets => (row.secrets ? (JSON.parse(decryptSecret(String(row.secrets))) as StoredSecrets) : { variables: [] });
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
    githubTokenSet: Boolean(secrets.githubToken),
    vercelTokenSet: Boolean(secrets.vercelToken),
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
  return {
    githubToken: keepOrReplace(previous.githubToken, input.githubToken),
    vercelToken: keepOrReplace(previous.vercelToken, input.vercelToken),
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
      .prepare("INSERT INTO environments (id, name, git_name, git_email, ssh_key_path, secrets, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(environmentId, input.name, input.gitName, input.gitEmail, input.sshKeyPath, encryptSecret(JSON.stringify(mergeSecrets({ variables: [] }, input))), Date.now());
    writeProjects(environmentId, input.projectIds);
    publishChange();
    return environmentStore.get(environmentId);
  },

  update(environmentId: string, input: EnvironmentInput): Environment {
    const row = requireRow(environmentId);
    database
      .prepare("UPDATE environments SET name = ?, git_name = ?, git_email = ?, ssh_key_path = ?, secrets = ? WHERE id = ?")
      .run(input.name, input.gitName, input.gitEmail, input.sshKeyPath, encryptSecret(JSON.stringify(mergeSecrets(readSecrets(row), input))), environmentId);
    writeProjects(environmentId, input.projectIds);
    publishChange();
    return environmentStore.get(environmentId);
  },

  remove(environmentId: string): void {
    database.prepare("DELETE FROM environment_projects WHERE environment_id = ?").run(environmentId);
    database.prepare("DELETE FROM environments WHERE id = ?").run(environmentId);
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
    if (secrets.githubToken) {
      Object.assign(variables, {
        GH_TOKEN: secrets.githubToken,
        GITHUB_TOKEN: secrets.githubToken,
        // git push/pull over HTTPS: drop other helpers (keychain, gh) and answer with the token.
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_1: githubCredentialHelper,
      });
    }
    if (secrets.vercelToken) variables.VERCEL_TOKEN = secrets.vercelToken;
    const gitName = String(row.git_name);
    const gitEmail = String(row.git_email);
    if (gitName) Object.assign(variables, { GIT_AUTHOR_NAME: gitName, GIT_COMMITTER_NAME: gitName });
    if (gitEmail) Object.assign(variables, { GIT_AUTHOR_EMAIL: gitEmail, GIT_COMMITTER_EMAIL: gitEmail });
    const sshKeyPath = String(row.ssh_key_path);
    if (sshKeyPath) variables.GIT_SSH_COMMAND = `ssh -i '${sshKeyPath.replace(/'/g, "'\\''")}' -o IdentitiesOnly=yes`;
    for (const variable of secrets.variables) variables[variable.key] = variable.value;
    return variables;
  },

  /** Short note for the system prompt: which accounts are active (never values). */
  contextFor(projectId: string): string {
    const environment = environmentStore.forProject(projectId);
    if (!environment) return "";
    const accounts = [environment.githubTokenSet && "GitHub (GH_TOKEN, git über HTTPS)", environment.vercelTokenSet && "Vercel (VERCEL_TOKEN)", environment.sshKeyPath && "SSH-Key für git"].filter(Boolean);
    return [
      `Umgebung „${environment.name}“ ist aktiv. Ihre Konten und Variablen sind in der Shell bereits gesetzt – nicht umloggen, kein \`gh auth switch\`/\`vercel login\`.`,
      accounts.length ? `Konten: ${accounts.join(", ")}.` : "",
      environment.gitName || environment.gitEmail ? `Git-Identität: ${[environment.gitName, environment.gitEmail && `<${environment.gitEmail}>`].filter(Boolean).join(" ")}.` : "",
      environment.variables.length ? `Variablen: ${environment.variables.map((variable) => variable.key).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },

  /** Asks GitHub / Vercel who the stored tokens belong to. */
  async checkAccounts(environmentId: string): Promise<{ github?: AccountCheck; vercel?: AccountCheck }> {
    const secrets = readSecrets(requireRow(environmentId));
    const check = async (url: string, token: string, pickName: (body: Record<string, unknown>) => unknown): Promise<AccountCheck> => {
      try {
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, "user-agent": "harnold" }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return { ok: false, detail: response.status === 401 || response.status === 403 ? "Token ungültig" : `HTTP ${response.status}` };
        return { ok: true, detail: String(pickName((await response.json()) as Record<string, unknown>) ?? "verbunden") };
      } catch (checkError) {
        return { ok: false, detail: checkError instanceof Error ? checkError.message : String(checkError) };
      }
    };
    const [github, vercel] = await Promise.all([
      secrets.githubToken ? check("https://api.github.com/user", secrets.githubToken, (body) => body.login) : undefined,
      secrets.vercelToken
        ? check("https://api.vercel.com/v2/user", secrets.vercelToken, (body) => {
            const user = body.user as Record<string, unknown> | undefined;
            return user?.username ?? user?.email;
          })
        : undefined,
    ]);
    return { github, vercel };
  },
};

export type AccountCheck = { ok: boolean; detail: string };
