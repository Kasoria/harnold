import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Account types an environment can hold. Each maps its fields onto the env vars the provider's CLI/SDK reads,
 * can say who a token belongs to (check) and can pick up the login that is active on this machine (detect).
 * Anything not listed here goes into free variables.
 */
export type ProviderField = { key: string; label: string; secret: boolean; placeholder?: string };
type ProviderCheck = { url: (values: Record<string, string>) => string; headers: (values: Record<string, string>) => Record<string, string>; pick: (body: unknown) => unknown };
export type EnvironmentProvider = {
  id: string;
  label: string;
  fields: ProviderField[];
  /** Extra env names that get the value of a field (e.g. GITHUB_TOKEN = GH_TOKEN). */
  aliases?: Record<string, string[]>;
  check?: ProviderCheck;
  /** Current login on this machine (CLI config files, env, CLI calls). */
  detect?: () => Promise<Record<string, string> | null>;
};

const home = os.homedir();
const bearer = (key: string) => (values: Record<string, string>) => ({ authorization: `Bearer ${values[key]}` });
const field = (key: string, label: string, secret = true, placeholder?: string): ProviderField => ({ key, label, secret, placeholder });
const record = (body: unknown) => (body && typeof body === "object" ? (body as Record<string, unknown>) : {});

const runCommand = (command: string, args: string[]) =>
  new Promise<string | null>((resolve) => {
    execFile(command, args, { timeout: 8_000 }, (runError, standardOutput) => resolve(runError ? null : standardOutput.trim() || null));
  });

const readFirstFile = (candidatePaths: string[]): string | null => {
  for (const candidatePath of candidatePaths) {
    try {
      return fs.readFileSync(candidatePath, "utf8");
    } catch {
      /* try next */
    }
  }
  return null;
};

const readJson = (candidatePaths: string[]): Record<string, unknown> | null => {
  const content = readFirstFile(candidatePaths);
  if (!content) return null;
  try {
    return record(JSON.parse(content));
  } catch {
    return null;
  }
};

/** Values of the given env vars from Harnold's own process environment (only the set ones). */
const fromProcessEnv = (...keys: string[]) => {
  const values = Object.fromEntries(keys.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
  return Object.keys(values).length ? values : null;
};

const appSupport = (folder: string) => [path.join(home, "Library", "Application Support", folder), path.join(home, ".local", "share", folder), path.join(home, ".config", folder)];

export const environmentProviders: EnvironmentProvider[] = [
  {
    id: "github",
    label: "GitHub",
    fields: [field("GH_TOKEN", "Token", true, "github_pat_…")],
    aliases: { GH_TOKEN: ["GITHUB_TOKEN"] },
    check: { url: () => "https://api.github.com/user", headers: bearer("GH_TOKEN"), pick: (body) => record(body).login },
    detect: async () => {
      const token = (await runCommand("gh", ["auth", "token"])) ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
      return token ? { GH_TOKEN: token } : null;
    },
  },
  {
    id: "gitlab",
    label: "GitLab",
    fields: [field("GITLAB_TOKEN", "Token", true, "glpat-…"), field("GITLAB_HOST", "Host", false, "gitlab.com")],
    check: {
      url: (values) => `https://${values.GITLAB_HOST || "gitlab.com"}/api/v4/user`,
      headers: (values) => ({ "private-token": values.GITLAB_TOKEN }),
      pick: (body) => record(body).username,
    },
    detect: async () => fromProcessEnv("GITLAB_TOKEN", "GITLAB_HOST"),
  },
  {
    id: "vercel",
    label: "Vercel",
    fields: [field("VERCEL_TOKEN", "Token")],
    check: {
      url: () => "https://api.vercel.com/v2/user",
      headers: bearer("VERCEL_TOKEN"),
      pick: (body) => {
        const user = record(record(body).user);
        return user.username ?? user.email;
      },
    },
    detect: async () => {
      const token = readJson(appSupport("com.vercel.cli").map((directory) => path.join(directory, "auth.json")))?.token;
      return typeof token === "string" ? { VERCEL_TOKEN: token } : fromProcessEnv("VERCEL_TOKEN");
    },
  },
  {
    id: "netlify",
    label: "Netlify",
    fields: [field("NETLIFY_AUTH_TOKEN", "Token")],
    check: { url: () => "https://api.netlify.com/api/v1/user", headers: bearer("NETLIFY_AUTH_TOKEN"), pick: (body) => record(body).email ?? record(body).full_name },
    detect: async () => {
      const netlifyConfig = readJson([
        path.join(home, "Library", "Preferences", "netlify", "config.json"),
        path.join(home, ".config", "netlify", "config.json"),
        path.join(home, ".netlify", "config.json"),
      ]);
      const users = record(netlifyConfig?.users);
      const user = record(users[String(netlifyConfig?.userId)] ?? Object.values(users)[0]);
      const token = record(user.auth).token;
      return typeof token === "string" ? { NETLIFY_AUTH_TOKEN: token } : fromProcessEnv("NETLIFY_AUTH_TOKEN");
    },
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    fields: [field("CLOUDFLARE_API_TOKEN", "API-Token"), field("CLOUDFLARE_ACCOUNT_ID", "Account-ID", false)],
    check: { url: () => "https://api.cloudflare.com/client/v4/user/tokens/verify", headers: bearer("CLOUDFLARE_API_TOKEN"), pick: (body) => record(record(body).result).status },
    detect: async () => fromProcessEnv("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"),
  },
  {
    id: "supabase",
    label: "Supabase",
    fields: [field("SUPABASE_ACCESS_TOKEN", "Access-Token", true, "sbp_…")],
    check: { url: () => "https://api.supabase.com/v1/projects", headers: bearer("SUPABASE_ACCESS_TOKEN"), pick: (body) => (Array.isArray(body) ? `${body.length} Projekte` : undefined) },
    detect: async () => {
      const token = readFirstFile([path.join(home, ".supabase", "access-token")])?.trim();
      return token ? { SUPABASE_ACCESS_TOKEN: token } : fromProcessEnv("SUPABASE_ACCESS_TOKEN");
    },
  },
  {
    id: "aws",
    label: "AWS",
    fields: [field("AWS_PROFILE", "Profil", false, "default"), field("AWS_ACCESS_KEY_ID", "Access-Key-ID"), field("AWS_SECRET_ACCESS_KEY", "Secret-Access-Key"), field("AWS_REGION", "Region", false, "eu-central-1")],
    detect: async () => fromProcessEnv("AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"),
  },
  {
    id: "gcloud",
    label: "Google Cloud",
    fields: [field("CLOUDSDK_CORE_ACCOUNT", "Konto", false), field("CLOUDSDK_CORE_PROJECT", "Projekt", false), field("GOOGLE_APPLICATION_CREDENTIALS", "Service-Account-Datei", false, "/pfad/key.json")],
    detect: async () => {
      const [account, project] = await Promise.all([runCommand("gcloud", ["config", "get-value", "account"]), runCommand("gcloud", ["config", "get-value", "project"])]);
      const values = Object.fromEntries([["CLOUDSDK_CORE_ACCOUNT", account], ["CLOUDSDK_CORE_PROJECT", project]].filter((entry): entry is [string, string] => Boolean(entry[1])));
      return Object.keys(values).length ? values : null;
    },
  },
  {
    id: "fly",
    label: "Fly.io",
    fields: [field("FLY_API_TOKEN", "Token")],
    detect: async () => {
      const token = readFirstFile([path.join(home, ".fly", "config.yml")])?.match(/access_token:\s*(\S+)/)?.[1];
      return token ? { FLY_API_TOKEN: token } : fromProcessEnv("FLY_API_TOKEN");
    },
  },
  {
    id: "railway",
    label: "Railway",
    fields: [field("RAILWAY_API_TOKEN", "Token")],
    detect: async () => {
      const token = record(readJson([path.join(home, ".railway", "config.json")])?.user).token;
      return typeof token === "string" ? { RAILWAY_API_TOKEN: token } : fromProcessEnv("RAILWAY_API_TOKEN");
    },
  },
  {
    id: "render",
    label: "Render",
    fields: [field("RENDER_API_KEY", "API-Key", true, "rnd_…")],
    check: { url: () => "https://api.render.com/v1/owners?limit=1", headers: bearer("RENDER_API_KEY"), pick: (body) => (Array.isArray(body) ? record(record(body[0]).owner).name : undefined) },
    detect: async () => fromProcessEnv("RENDER_API_KEY"),
  },
  {
    id: "npm",
    label: "npm",
    fields: [field("NPM_TOKEN", "Token", true, "npm_…")],
    aliases: { NPM_TOKEN: ["npm_config_//registry.npmjs.org/:_authToken"] },
    check: { url: () => "https://registry.npmjs.org/-/whoami", headers: bearer("NPM_TOKEN"), pick: (body) => record(body).username },
    detect: async () => {
      const token = readFirstFile([path.join(home, ".npmrc")])?.match(/\/\/registry\.npmjs\.org\/:_authToken=(\S+)/)?.[1];
      return token && !token.startsWith("${") ? { NPM_TOKEN: token } : fromProcessEnv("NPM_TOKEN");
    },
  },
  {
    id: "expo",
    label: "Expo",
    fields: [field("EXPO_TOKEN", "Token")],
    detect: async () => fromProcessEnv("EXPO_TOKEN"),
  },
  {
    id: "stripe",
    label: "Stripe",
    fields: [field("STRIPE_API_KEY", "Secret-Key", true, "sk_test_…")],
    check: { url: () => "https://api.stripe.com/v1/account", headers: bearer("STRIPE_API_KEY"), pick: (body) => record(record(record(body).settings).dashboard).display_name ?? record(body).id },
    detect: async () => fromProcessEnv("STRIPE_API_KEY"),
  },
  {
    id: "sentry",
    label: "Sentry",
    fields: [field("SENTRY_AUTH_TOKEN", "Auth-Token", true, "sntrys_…"), field("SENTRY_ORG", "Organisation", false)],
    check: { url: () => "https://sentry.io/api/0/", headers: bearer("SENTRY_AUTH_TOKEN"), pick: (body) => record(record(body).user).email ?? "verbunden" },
    detect: async () => {
      const token = readFirstFile([path.join(home, ".sentryclirc")])?.match(/token\s*=\s*(\S+)/)?.[1];
      return token ? { SENTRY_AUTH_TOKEN: token, ...(fromProcessEnv("SENTRY_ORG") ?? {}) } : fromProcessEnv("SENTRY_AUTH_TOKEN", "SENTRY_ORG");
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    fields: [field("OPENAI_API_KEY", "API-Key", true, "sk-…")],
    check: { url: () => "https://api.openai.com/v1/models", headers: bearer("OPENAI_API_KEY"), pick: () => "gültig" },
    detect: async () => fromProcessEnv("OPENAI_API_KEY"),
  },
  {
    id: "gemini",
    label: "Google Gemini",
    fields: [field("GEMINI_API_KEY", "API-Key")],
    detect: async () => fromProcessEnv("GEMINI_API_KEY"),
  },
  {
    id: "linear",
    label: "Linear",
    fields: [field("LINEAR_API_KEY", "API-Key", true, "lin_api_…")],
    detect: async () => fromProcessEnv("LINEAR_API_KEY"),
  },
];

export const findProvider = (providerId: string) => environmentProviders.find((provider) => provider.id === providerId);

/** Public view (no functions) for the UI and the agent. */
export const presentProviders = () =>
  environmentProviders.map((provider) => ({ id: provider.id, label: provider.label, fields: provider.fields, checkable: Boolean(provider.check) }));

export type AccountCheck = { ok: boolean; detail: string };

export async function checkProviderAccount(provider: EnvironmentProvider, values: Record<string, string>): Promise<AccountCheck | undefined> {
  if (!provider.check) return undefined;
  try {
    const response = await fetch(provider.check.url(values), {
      headers: { ...provider.check.headers(values), "user-agent": "harnold" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, detail: response.status === 401 || response.status === 403 ? "Token ungültig" : `HTTP ${response.status}` };
    return { ok: true, detail: String(provider.check.pick(await response.json()) ?? "verbunden") };
  } catch (checkError) {
    return { ok: false, detail: checkError instanceof Error ? checkError.message : String(checkError) };
  }
}

/** Git identity of this machine (global config). */
export async function detectGitIdentity(): Promise<{ gitName: string; gitEmail: string }> {
  const [gitName, gitEmail] = await Promise.all([runCommand("git", ["config", "--global", "user.name"]), runCommand("git", ["config", "--global", "user.email"])]);
  return { gitName: gitName ?? "", gitEmail: gitEmail ?? "" };
}
