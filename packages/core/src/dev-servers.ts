import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.ts";
import { t } from "./i18n.ts";

/**
 * Dev servers the agent starts (npm run dev, vite, next …) and a proxy that makes them reachable from outside.
 * On a server only Harnold's port is published; the proxy listens on its own port (HARNOLD_PREVIEW_PORT) and
 * forwards everything (incl. WebSockets for hot reload) to the dev server the user opened. Own origin, so apps
 * with absolute paths (/assets, /_next, /@vite) work unchanged and can't read Harnold's token.
 */

const execFileAsync = promisify(execFile);

export type DevServer = {
  port: number;
  /** Where the proxy connects: 127.0.0.1, ::1 or the Docker service. */
  targetHost: string;
  processName?: string;
  /** Working directory of the process: assigns the server to a project. */
  workingDirectory?: string;
  /** Started in the Docker sidecar (docker compose …). */
  container?: string;
  /** Looks like something to open in a browser (dev runtime or container), not a background app. */
  likelyApp?: boolean;
};

export const previewProxyPort = process.env.HARNOLD_PREVIEW_PORT ? Number(process.env.HARNOLD_PREVIEW_PORT) : null;
/** Port the browser uses (Caddy: 8443); without it the compose file is older than the proxy. */
const previewPublicPort = process.env.HARNOLD_PREVIEW_PUBLIC_PORT ? Number(process.env.HARNOLD_PREVIEW_PUBLIC_PORT) : null;
const previewPublicUrl = process.env.HARNOLD_PREVIEW_PUBLIC_URL?.replace(/\/$/, "") || null;

const ownPorts = new Set([config.port, previewProxyPort].filter((port): port is number => Boolean(port)));

// --- Detection ---

/** Linux: listening TCP sockets from /proc/net, mapped to their process via /proc/<pid>/fd. */
function linuxListeningSockets(): DevServer[] {
  const ownUid = process.getuid?.() ?? -1;
  const socketsByInode = new Map<string, DevServer>();
  for (const tableName of ["tcp", "tcp6"]) {
    let table = "";
    try {
      table = fs.readFileSync(`/proc/net/${tableName}`, "utf8");
    } catch {
      continue;
    }
    for (const line of table.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 10 || columns[3] !== "0A") continue; // 0A = LISTEN
      if (Number(columns[7]) !== ownUid) continue;
      const [hexAddress, hexPort] = columns[1].split(":");
      const port = parseInt(hexPort, 16);
      const listensOnIpv6Loopback = hexAddress === "00000000000000000000000001000000";
      const targetHost = tableName === "tcp6" && listensOnIpv6Loopback ? "::1" : "127.0.0.1";
      // A server on both families appears twice; IPv4 wins.
      if (![...socketsByInode.values()].some((known) => known.port === port)) socketsByInode.set(columns[9], { port, targetHost });
    }
  }
  if (!socketsByInode.size) return [];
  for (const processId of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    let descriptors: string[];
    try {
      descriptors = fs.readdirSync(`/proc/${processId}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      let linkTarget = "";
      try {
        linkTarget = fs.readlinkSync(`/proc/${processId}/fd/${descriptor}`);
      } catch {
        continue;
      }
      const socketInode = /^socket:\[(\d+)\]$/.exec(linkTarget)?.[1];
      const devServer = socketInode ? socketsByInode.get(socketInode) : undefined;
      if (!devServer || devServer.processName) continue;
      try {
        devServer.processName = fs.readFileSync(`/proc/${processId}/cmdline`, "utf8").split("\0").filter(Boolean).slice(0, 3).join(" ");
        devServer.workingDirectory = fs.readlinkSync(`/proc/${processId}/cwd`);
      } catch {
        // process ended meanwhile
      }
    }
  }
  return [...socketsByInode.values()];
}

/** macOS (desktop app): lsof lists the user's own listening sockets. */
async function macListeningSockets(): Promise<DevServer[]> {
  let listing = "";
  try {
    listing = (await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: 3000 })).stdout;
  } catch (lsofError) {
    listing = (lsofError as { stdout?: string }).stdout ?? ""; // exit code 1 with partial output is normal
  }
  const devServers = new Map<number, DevServer & { processId: string }>();
  let processId = "";
  let processName = "";
  for (const line of listing.split("\n")) {
    if (line.startsWith("p")) processId = line.slice(1);
    else if (line.startsWith("c")) processName = line.slice(1);
    else if (line.startsWith("n")) {
      const address = line.slice(1);
      const port = Number(address.slice(address.lastIndexOf(":") + 1));
      if (!port || devServers.has(port)) continue;
      const targetHost = address.startsWith("[::1]") ? "::1" : "127.0.0.1";
      devServers.set(port, { port, targetHost, processName, processId });
    }
  }
  const processIds = [...new Set([...devServers.values()].map((devServer) => devServer.processId))];
  if (processIds.length) {
    try {
      const cwdListing = (await execFileAsync("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", processIds.join(",")], { timeout: 3000 })).stdout;
      let currentProcessId = "";
      const cwdByProcessId = new Map<string, string>();
      for (const line of cwdListing.split("\n")) {
        if (line.startsWith("p")) currentProcessId = line.slice(1);
        else if (line.startsWith("n")) cwdByProcessId.set(currentProcessId, line.slice(1));
      }
      for (const devServer of devServers.values()) devServer.workingDirectory = cwdByProcessId.get(devServer.processId);
    } catch {
      // without working directories the servers are still listed
    }
  }
  return [...devServers.values()].map(({ processId: _processId, ...devServer }) => devServer);
}

/** Docker sidecar (opt-in): containers with published ports, reachable under the Docker service's host name. */
async function dockerPublishedPorts(): Promise<DevServer[]> {
  const dockerHost = process.env.DOCKER_HOST;
  if (!dockerHost?.startsWith("tcp://")) return [];
  const dockerApiBase = dockerHost.replace(/^tcp:/, "http:");
  try {
    const response = await fetch(`${dockerApiBase}/containers/json`, { signal: AbortSignal.timeout(2000) });
    const containers = (await response.json()) as { Names?: string[]; Ports?: { PublicPort?: number; Type?: string }[]; Labels?: Record<string, string> }[];
    const targetHost = new URL(dockerApiBase).hostname;
    return containers.flatMap((container) =>
      (container.Ports ?? [])
        .filter((portMapping) => portMapping.PublicPort && portMapping.Type === "tcp")
        .map((portMapping) => ({
          port: portMapping.PublicPort!,
          targetHost,
          container: container.Names?.[0]?.replace(/^\//, ""),
          workingDirectory: container.Labels?.["com.docker.compose.project.working_dir"],
        })),
    );
  } catch {
    return [];
  }
}

/** Processes that listen but aren't something to look at. */
const ignoredProcessPattern = /\b(sshd|cupsd|rapportd|ControlCe|AirPlay|Spotify|Dropbox|postgres|mysqld|redis-server|mongod|containerd|dockerd)\b/i;
/** Runtimes dev servers run in (npm run dev, vite, next, python -m http.server, rails …). */
const appRuntimePattern = /^(node|nodejs|bun|deno|python[\d.]*|uvicorn|gunicorn|flask|ruby|rails|puma|php|php-fpm|java|dotnet|go|hugo|caddy|nginx|httpd|vite|next-server|astro|esbuild|wrangler|webpack)$/i;

function executableName(processName: string): string {
  const firstToken = processName.trim().split(/\s+/)[0] ?? "";
  return firstToken.split("/").pop() ?? firstToken;
}

export async function listDevServers(): Promise<DevServer[]> {
  const localServers = process.platform === "linux" ? linuxListeningSockets() : process.platform === "darwin" ? await macListeningSockets() : [];
  const seenTargets = new Set<string>();
  // Docker lists a published port once per address family.
  const allServers = [...localServers, ...(await dockerPublishedPorts())].filter((devServer) => {
    const targetKey = `${devServer.targetHost}:${devServer.port}`;
    if (seenTargets.has(targetKey)) return false;
    seenTargets.add(targetKey);
    return true;
  });
  return allServers
    .filter((devServer) => !ownPorts.has(devServer.port) && !(devServer.processName && ignoredProcessPattern.test(devServer.processName)))
    .map((devServer) => ({ ...devServer, likelyApp: Boolean(devServer.container) || (devServer.processName ? appRuntimePattern.test(executableName(devServer.processName)) : false) }))
    .sort((first, second) => first.port - second.port);
}

// --- Opening ---

type PreviewTarget = { port: number; targetHost: string };
type PreviewTicket = PreviewTarget & { expiresAt: number; route: string };
/** One-time tickets from the authenticated API; redeemed on the proxy port for a session cookie. */
const ticketsById = new Map<string, PreviewTicket>();
/** Session cookie → dev server; in memory, a restart requires opening the preview again. */
const previewSessionsById = new Map<string, PreviewTarget>();
const ticketLifetimeMs = 60_000;
const previewCookieName = "harnold_preview";
const ticketPath = "/__harnold/open";

export type PreviewOpening =
  | { mode: "direct"; url: string }
  | { mode: "proxy"; url?: string; path: string; publicPort: number }
  | { mode: "unavailable"; reason: string };

/** Only same-origin paths ("/pricing?x=1"), never "//other.host" or full URLs. */
export function normalizeRoute(route: string | undefined | null): string {
  const trimmedRoute = (route ?? "").trim();
  if (!trimmedRoute) return "/";
  const withSlash = trimmedRoute.startsWith("/") ? trimmedRoute : "/" + trimmedRoute;
  if (/^\/[\/\\]/.test(withSlash)) return "/";
  // Header-safe: spaces, umlauts and control characters percent-encoded.
  return withSlash.replace(/[^\x21-\x7e]/g, (character) => encodeURIComponent(character));
}

export async function openDevServer(port: number, route?: string): Promise<PreviewOpening> {
  // A local server wins over a container with the same published port.
  const devServer = (await listDevServers()).find((candidate) => candidate.port === port);
  if (!devServer) return { mode: "unavailable", reason: t("Auf Port {0} läuft kein Server mehr.", String(port)) };
  // Desktop app: the browser runs on the same machine as the dev server.
  if (!previewProxyPort) return { mode: "direct", url: `http://localhost:${port}${normalizeRoute(route)}` };
  if (!previewPublicPort && !previewPublicUrl) {
    return { mode: "unavailable", reason: t("Die Vorschau braucht eine neuere Compose-Datei: install.sh auf dem Server erneut ausführen.") };
  }
  const now = Date.now();
  for (const [ticketId, ticket] of ticketsById) if (ticket.expiresAt < now) ticketsById.delete(ticketId);
  const ticketId = randomBytes(24).toString("base64url");
  ticketsById.set(ticketId, { port, targetHost: devServer.targetHost, expiresAt: now + ticketLifetimeMs, route: normalizeRoute(route) });
  const pathWithTicket = `${ticketPath}?ticket=${ticketId}`;
  return previewPublicUrl
    ? { mode: "proxy", url: previewPublicUrl + pathWithTicket, path: pathWithTicket, publicPort: previewPublicPort ?? 0 }
    : { mode: "proxy", path: pathWithTicket, publicPort: previewPublicPort! };
}

/** For the agent: tells it that the user sees its dev servers in Harnold (server mode only). */
export function devServerInstructions(): string {
  if (!previewProxyPort) return "";
  const dockerLine = process.env.DOCKER_HOST?.startsWith("tcp://")
    ? `\n- Docker läuft in einem eigenen Dienst (${process.env.DOCKER_HOST}). Veröffentlichte Container-Ports erreichst du unter ${new URL(process.env.DOCKER_HOST.replace(/^tcp:/, "http:")).hostname}:PORT, nicht unter localhost. Bind-Mounts funktionieren für Pfade unter /data und /home/harnold.`
    : "";
  return `Harnold läuft auf einem Server (${os.hostname()}). Dev-Server, die du startest (npm run dev o. Ä.), öffnet der Nutzer über Harnolds Vorschau (Workspace → App); er kann localhost-Adressen nicht direkt aufrufen. Lange laufende Server im Hintergrund starten.${dockerLine}`;
}

// --- Proxy ---

function cookieValue(cookieHeader: string | undefined, cookieName: string): string | undefined {
  return cookieHeader
    ?.split(";")
    .map((cookiePart) => cookiePart.trim())
    .find((cookiePart) => cookiePart.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
}

function withoutPreviewCookie(cookieHeader: string | undefined): string | undefined {
  const remainingCookies = cookieHeader
    ?.split(";")
    .map((cookiePart) => cookiePart.trim())
    .filter((cookiePart) => cookiePart && !cookiePart.startsWith(previewCookieName + "="));
  return remainingCookies?.length ? remainingCookies.join("; ") : undefined;
}

/** Dev servers check Host/Origin (Vite allowedHosts, Next allowedDevOrigins): they see a local browser. */
function upstreamHeaders(request: http.IncomingMessage, target: PreviewTarget): http.OutgoingHttpHeaders {
  const localOrigin = `http://localhost:${target.port}`;
  const headers: http.OutgoingHttpHeaders = { ...request.headers, host: `localhost:${target.port}` };
  if (headers.origin) headers.origin = localOrigin;
  if (typeof headers.referer === "string") headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, localOrigin);
  const cookies = withoutPreviewCookie(request.headers.cookie);
  if (cookies) headers.cookie = cookies;
  else delete headers.cookie;
  for (const forwardedHeader of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]) delete headers[forwardedHeader];
  return headers;
}

function isHttpsRequest(request: http.IncomingMessage): boolean {
  return String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

function messagePage(response: http.ServerResponse, statusCode: number, message: string) {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Harnold</title>` +
      `<body style="font:14px system-ui;color:#555;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px">` +
      `<p>${message.replace(/</g, "&lt;")}</p></body>`,
  );
}

function redeemTicket(request: http.IncomingMessage, response: http.ServerResponse, requestUrl: URL) {
  const ticket = ticketsById.get(requestUrl.searchParams.get("ticket") ?? "");
  if (!ticket || ticket.expiresAt < Date.now()) {
    messagePage(response, 403, t("Dieser Vorschau-Link ist abgelaufen. In Harnold erneut öffnen."));
    return;
  }
  ticketsById.delete(requestUrl.searchParams.get("ticket")!);
  const sessionId = randomBytes(24).toString("base64url");
  previewSessionsById.set(sessionId, { port: ticket.port, targetHost: ticket.targetHost });
  // Embedded in Harnold from another site (desktop app → server) the cookie must be SameSite=None (only with HTTPS);
  // Partitioned keeps it working where third-party cookies are blocked.
  const cookieAttributes = isHttpsRequest(request) ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax";
  response.writeHead(302, {
    location: ticket.route,
    "set-cookie": `${previewCookieName}=${sessionId}; Path=/; HttpOnly; ${cookieAttributes}`,
    "cache-control": "no-store",
  });
  response.end();
}

function targetFor(request: http.IncomingMessage): PreviewTarget | undefined {
  const sessionId = cookieValue(request.headers.cookie, previewCookieName);
  return sessionId ? previewSessionsById.get(sessionId) : undefined;
}

function proxyRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  const requestUrl = new URL(request.url ?? "/", "http://preview.invalid");
  if (requestUrl.pathname === ticketPath) return redeemTicket(request, response, requestUrl);
  const target = targetFor(request);
  if (!target) return messagePage(response, 401, t("Keine Vorschau geöffnet. Öffne den Server in Harnold unter Workspace → App."));
  const upstreamRequest = http.request(
    { host: target.targetHost, port: target.port, method: request.method, path: request.url, headers: upstreamHeaders(request, target) },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      // Redirects to the dev server's own address stay inside the proxy.
      if (typeof responseHeaders.location === "string") {
        responseHeaders.location = responseHeaders.location.replace(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?/i, "");
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );
  upstreamRequest.on("error", () => {
    if (!response.headersSent) messagePage(response, 502, t("Der Server auf Port {0} antwortet nicht (beendet?).", String(target.port)));
    else response.destroy();
  });
  request.pipe(upstreamRequest);
}

/** WebSockets (hot reload): the upgrade request is passed on as raw bytes, then both sockets are piped. */
function proxyUpgrade(request: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) {
  const target = targetFor(request);
  if (!target) {
    clientSocket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  const upstreamSocket = net.connect(target.port, target.targetHost, () => {
    const headers = upstreamHeaders(request, target);
    const headerLines = Object.entries(headers).flatMap(([headerName, headerValue]) =>
      headerValue === undefined ? [] : (Array.isArray(headerValue) ? headerValue : [headerValue]).map((singleValue) => `${headerName}: ${singleValue}`),
    );
    upstreamSocket.write(`${request.method} ${request.url} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
  const closeBoth = () => {
    upstreamSocket.destroy();
    clientSocket.destroy();
  };
  upstreamSocket.on("error", closeBoth);
  clientSocket.on("error", closeBoth);
}

export function startPreviewProxy() {
  if (!previewProxyPort) return;
  const proxyServer = http.createServer(proxyRequest);
  proxyServer.on("upgrade", proxyUpgrade);
  proxyServer.on("error", (serverError) => console.error("[preview] Proxy konnte nicht starten:", serverError.message));
  proxyServer.listen(previewProxyPort, config.host, () => console.log(`Harnold Vorschau-Proxy auf http://${config.host}:${previewProxyPort}`));
}
