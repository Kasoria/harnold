import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { applyPendingImport } from "./import-apply.ts";

const dataDirectory = process.env.HARNOLD_DATA_DIR ?? path.join(os.homedir(), ".harnold");
const projectsDirectory = process.env.HARNOLD_PROJECTS_DIR ?? path.join(dataDirectory, "projects");

fs.mkdirSync(dataDirectory, { recursive: true });
fs.mkdirSync(projectsDirectory, { recursive: true });
// A workspace uploaded earlier replaces the data now, before the database is opened.
applyPendingImport(dataDirectory, projectsDirectory);

export const config = {
  dataDirectory,
  projectsDirectory,
  databasePath: path.join(dataDirectory, "harnold.db"),
  host: process.env.HARNOLD_HOST ?? "127.0.0.1",
  port: Number(process.env.HARNOLD_PORT ?? 4317),
  /** Optional: required as Bearer token / ?token= when set (server mode). */
  accessToken: process.env.HARNOLD_TOKEN || undefined,
  defaultModel: process.env.HARNOLD_MODEL || undefined,
};
