import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { t } from "./i18n.ts";

/**
 * SSRF guard for outbound requests whose target comes from user input (provider base URLs,
 * account-check hosts). Only http(s) URLs whose hosts resolve exclusively to public addresses
 * may be fetched. Loopback stays allowed so local LLM gateways (Ollama, LM Studio) keep working.
 */
export function isBlockedIpAddress(ip: string): boolean {
  const address = ip.toLowerCase();
  if (address.includes(":")) {
    if (address === "::1") return false; // loopback (allowed)
    if (address === "::") return true; // unspecified
    if (address.startsWith("fe80:") || address.startsWith("fec0:")) return true; // link-local
    if (/^f[cd]/.test(address)) return true; // ULA fc00::/7
    return false;
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return false; // loopback (allowed: local LLM gateways)
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Throws when the URL is not a public http(s) URL (or loopback, for local gateways). */
export async function assertAllowedHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(t("Ungültige URL"));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(t("Nur http(s)-URLs sind erlaubt"));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) throw new Error(t("Adresse nicht erlaubt (privates Netzwerk)"));
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(t("Host nicht auflösbar"));
  }
  // Reject when any resolved address is private/link-local (defends against DNS rebinding).
  if (!addresses.length || addresses.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new Error(t("Adresse nicht erlaubt (privates Netzwerk)"));
  }
}
