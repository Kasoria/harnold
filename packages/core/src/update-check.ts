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
