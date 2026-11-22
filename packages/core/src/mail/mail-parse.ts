/**
 * Shared helpers for parsing inbound e-mail. Used by both the E-Mail channel
 * (user ↔ Harnold) and the mailbox integration (agent works the user's inbox).
 */

/**
 * A `From:` address can be forged. Harnold therefore believes the receiving mail server when it says the
 * mail failed authentication: an explicit `spf=fail`, `dkim=fail` or `dmarc=fail` means the sender is not
 * who the address claims. Missing headers (many servers don't add them) are not treated as a failure.
 */
export function failsAuthentication(authenticationResults: unknown): boolean {
  const headerText = Array.isArray(authenticationResults) ? authenticationResults.join(" ") : String(authenticationResults ?? "");
  if (!headerText) return false;
  return /\b(spf|dkim|dmarc)\s*=\s*(fail|softfail)\b/i.test(headerText);
}

/** Removes quoted history so only the new reply reaches the agent. */
export function stripQuotedReply(text: string): string {
  const keptLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^>/.test(line) || /^(On .+ wrote:|Am .+ schrieb .+:)$/.test(line.trim())) break;
    keptLines.push(line);
  }
  return keptLines.join("\n").trim();
}
