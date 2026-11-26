const MAX_TASK_NAME_LENGTH = 48;

/**
 * Short, readable name for a background task. The SDK hands over the whole shell command
 * (often a heredoc with a full script) as description/summary; this keeps the first command only.
 */
export function shortTaskName(rawText: string | undefined | null): string {
  if (!rawText) return "";
  let firstLine = rawText.split("\n").find((line) => line.trim())?.trim() ?? "";
  // Heredoc: "python3 - <<'EOF' p=…" -> "python3 - ", "cat > f <<'EOF' …" -> "cat > f"
  const heredocIndex = firstLine.indexOf("<<");
  const hasHeredoc = heredocIndex > 0;
  if (hasHeredoc) firstLine = firstLine.slice(0, heredocIndex).trim();
  // Only the first command of a chain: "a && b ; c | d" -> "a"
  firstLine = firstLine.split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? firstLine;
  firstLine = firstLine.replace(/\s+/g, " ").trim();
  if (hasHeredoc && / -$/.test(firstLine)) firstLine = `${firstLine.slice(0, -2)} (Skript)`;
  return firstLine.length > MAX_TASK_NAME_LENGTH ? `${firstLine.slice(0, MAX_TASK_NAME_LENGTH - 1).trimEnd()}…` : firstLine;
}
