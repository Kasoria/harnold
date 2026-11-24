import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import fs from "node:fs";

/** One version for app and UI: the desktop app's (tauri.conf.json). */
// Docker image builds get the version from the release tag (the tagged commit predates the version bump commit).
const appVersion: string = process.env.HARNOLD_VERSION?.replace(/^v/, "") || JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../desktop/src-tauri/tauri.conf.json"), "utf8")).version;
const coreUrl = process.env.HARNOLD_CORE_URL ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __HARNOLD_VERSION__: JSON.stringify(appVersion) },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: 5317,
    proxy: {
      "/api": coreUrl,
      "/preview": coreUrl,
      "/ws": { target: coreUrl.replace(/^http/, "ws"), ws: true },
    },
  },
});
