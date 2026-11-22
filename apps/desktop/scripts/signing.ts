// macOS signiert Harnold mit einer festen Identität. Ohne das (ad-hoc-Signatur) ändert sich die
// Signatur mit jedem Build, macOS erkennt alte Ordner-Freigaben nicht wieder und fragt erneut –
// genau das passiert nach jedem Update.
import { execFileSync } from "node:child_process";

/** Signatur-Identität aus dem Schlüsselbund: Developer ID vor Apple Development, überschreibbar per HARNOLD_SIGNING_IDENTITY. */
export function signingIdentity(): string | undefined {
  const configuredIdentity = process.env.HARNOLD_SIGNING_IDENTITY?.trim();
  if (configuredIdentity) return configuredIdentity === "none" ? undefined : configuredIdentity;
  let identities: string[] = [];
  try {
    identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.match(/"(.+)"/)?.[1])
      .filter((identity): identity is string => Boolean(identity));
  } catch {
    return undefined;
  }
  return identities.find((identity) => identity.startsWith("Developer ID Application")) ?? identities.find((identity) => identity.startsWith("Apple Development"));
}
