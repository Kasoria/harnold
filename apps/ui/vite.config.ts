import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const coreUrl = process.env.HARNOLD_CORE_URL ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
