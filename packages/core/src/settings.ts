import { database } from "./db.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

database.exec(`
  CREATE TABLE IF NOT EXISTS workspace_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/** Small key/value store for workspace-wide settings; `secret` values are encrypted at rest. */
export const settingsStore = {
  read<Value>(key: string, fallback: Value): Value {
    const row = database.prepare("SELECT value FROM workspace_settings WHERE key = ?").get(key);
    return row ? (JSON.parse(String(row.value)) as Value) : fallback;
  },
  write(key: string, value: unknown): void {
    database
      .prepare("INSERT INTO workspace_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  },
  readSecrets(key: string): Record<string, string> {
    const encrypted = settingsStore.read<string | null>(key, null);
    return encrypted ? JSON.parse(decryptSecret(encrypted)) : {};
  },
  writeSecrets(key: string, secrets: Record<string, string>): void {
    settingsStore.write(key, encryptSecret(JSON.stringify(secrets)));
  },
};
