import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const readSettings = (filePath: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const asTokenCount = (value: unknown): number | undefined => {
  const tokenCount = typeof value === "string" ? Number(value) : value;
  return typeof tokenCount === "number" && Number.isFinite(tokenCount) && tokenCount > 0 ? tokenCount : undefined; // "auto" → undefined
};

/**
 * The token count at which Claude Code compacts on its own, when the user set one (settings `autoCompactWindow`,
 * per model under `modelSettings`, or CLAUDE_CODE_AUTO_COMPACT_WINDOW). That is the real "full" mark of the
 * context ring – not the model's maximum window.
 */
export function customAutoCompactWindow(model: string | undefined, workingDirectory: string, env: NodeJS.ProcessEnv): number | undefined {
  const userDirectory = env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  // Later files win: user < project < local.
  const settingsFiles = [path.join(userDirectory, "settings.json"), path.join(workingDirectory, ".claude", "settings.json"), path.join(workingDirectory, ".claude", "settings.local.json")].map(readSettings);
  let window: number | undefined = asTokenCount(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  for (const settings of settingsFiles) {
    const settingsEnv = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
    window = asTokenCount(settingsEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW) ?? window;
    window = asTokenCount(settings.autoCompactWindow) ?? window;
    const modelSettings = settings.modelSettings && typeof settings.modelSettings === "object" ? (settings.modelSettings as Record<string, unknown>) : {};
    const matchingKey = model ? Object.keys(modelSettings).find((modelKey) => model.startsWith(modelKey) || modelKey.startsWith(model)) : undefined;
    const modelEntry = matchingKey ? modelSettings[matchingKey] : undefined;
    if (modelEntry && typeof modelEntry === "object") window = asTokenCount((modelEntry as Record<string, unknown>).autoCompactWindow) ?? window;
  }
  return window;
}
