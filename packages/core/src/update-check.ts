import { t } from "./i18n.ts";

/** Newest published Harnold release (GitHub), cached; the UI compares it with its own version. */
const releasesUrl = "https://api.github.com/repos/Kasoria/harnold/releases/latest";
const cacheDurationMs = 60 * 60 * 1000;

export type LatestRelease = { version: string; notes: string | null; url: string };

let cachedRelease: { fetchedAt: number; release: LatestRelease | null } | null = null;

/** GitHub API (with notes). A token, where the environment has one, lifts the low anonymous rate limit. */
async function releaseFromApi(): Promise<LatestRelease | null> {
  const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(releasesUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "harnold-update-check",
      "cache-control": "no-cache",
      ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  const data = (await response.json()) as { tag_name?: string; body?: string; html_url?: string };
  const version = data.tag_name?.replace(/^v/, "");
  return version ? { version, notes: data.body?.trim() || null, url: data.html_url ?? "" } : null;
}

/** Fallback without rate limit: github.com redirects /releases/latest to the tag (no notes). */
async function releaseFromRedirect(): Promise<LatestRelease | null> {
  const response = await fetch("https://github.com/Kasoria/harnold/releases/latest", { method: "HEAD", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(8000) });
  const location = response.headers.get("location") ?? "";
  const version = /\/tag\/v?([^/?#]+)$/.exec(location)?.[1];
  if (!version) throw new Error(`GitHub ${response.status}`);
  return { version, notes: null, url: location };
}

/**
 * Background checks use a cache of an hour. A check the user asked for always goes to GitHub and reports a
 * failure instead of quietly answering with an old result.
 */
export async function latestRelease(forceRefresh = false): Promise<LatestRelease | null> {
  if (!forceRefresh && cachedRelease && Date.now() - cachedRelease.fetchedAt < cacheDurationMs) return cachedRelease.release;
  try {
    const release = await releaseFromApi().catch(() => releaseFromRedirect());
    cachedRelease = { fetchedAt: Date.now(), release };
    return release;
  } catch (checkError) {
    if (forceRefresh) throw new Error(t("GitHub ist nicht erreichbar ({0})", checkError instanceof Error ? checkError.message : String(checkError)));
    // Offline or rate-limited: keep the last known answer and try again in ten minutes.
    cachedRelease = { fetchedAt: Date.now() - cacheDurationMs + 10 * 60 * 1000, release: cachedRelease?.release ?? null };
    return cachedRelease.release;
  }
}

/** Only offer a release to Docker servers once its image exists in the registry (the build runs a few minutes after the release). */
export async function imagePublished(version: string): Promise<boolean> {
  try {
    const scope = "repository:kasoria/harnold:pull";
    const tokenResponse = await fetch(`https://ghcr.io/token?scope=${scope}`, { signal: AbortSignal.timeout(8000) });
    const { token } = (await tokenResponse.json()) as { token?: string };
    const manifestResponse = await fetch(`https://ghcr.io/v2/kasoria/harnold/manifests/${encodeURIComponent(version)}`, {
      method: "HEAD",
      headers: {
        authorization: `Bearer ${token ?? ""}`,
        accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json",
      },
      signal: AbortSignal.timeout(8000),
    });
    return manifestResponse.ok;
  } catch {
    return false;
  }
}

/** Triggers the update sidecar (Watchtower, reachable only inside the compose network) to pull the new image and restart Harnold. */
export async function requestUpdateInstall(): Promise<void> {
  const updaterUrl = process.env.HARNOLD_UPDATER_URL;
  if (!updaterUrl) throw new Error("Kein Update-Dienst konfiguriert");
  const response = await fetch(`${updaterUrl.replace(/\/$/, "")}/v1/update?async=true`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.HARNOLD_UPDATER_TOKEN ?? ""}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Update-Dienst antwortet mit ${response.status}`);
}
