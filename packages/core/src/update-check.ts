/** Newest published Harnold release (GitHub), cached; the UI compares it with its own version. */
const releasesUrl = "https://api.github.com/repos/Kasoria/harnold/releases/latest";
const cacheDurationMs = 6 * 60 * 60 * 1000;

export type LatestRelease = { version: string; notes: string | null; url: string };

let cachedRelease: { fetchedAt: number; release: LatestRelease | null } | null = null;

export async function latestRelease(): Promise<LatestRelease | null> {
  if (cachedRelease && Date.now() - cachedRelease.fetchedAt < cacheDurationMs) return cachedRelease.release;
  try {
    const response = await fetch(releasesUrl, {
      headers: { accept: "application/vnd.github+json", "user-agent": "harnold-update-check" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(String(response.status));
    const data = (await response.json()) as { tag_name?: string; body?: string; html_url?: string };
    const version = data.tag_name?.replace(/^v/, "");
    const release = version ? { version, notes: data.body?.trim() || null, url: data.html_url ?? "" } : null;
    cachedRelease = { fetchedAt: Date.now(), release };
    return release;
  } catch {
    // Offline or rate-limited: keep the last known answer and try again later.
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
