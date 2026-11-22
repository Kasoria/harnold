import { t } from "../../i18n.ts";
import type { AgentBackend } from "../types.ts";
import { runNativeTurn } from "./agent-loop.ts";
import { nativeModels, nativeSettings } from "./settings.ts";

export { nativeModels, nativeSettings };

/** Harnold's own agent: no extra program, talks to any provider (Anthropic or OpenAI protocol) directly. */
export const nativeBackend: AgentBackend = {
  id: "native",
  name: "Harnold-Agent",
  capabilities: { interactivePermissions: true, questions: true, contextBreakdown: false, forkAtMessage: false, extensions: true },

  async status() {
    return { id: "native", name: "Harnold-Agent", ready: nativeModels().length > 0, runtime: null, capabilities: nativeBackend.capabilities };
  },

  async assertReady() {
    if (!nativeModels().length) throw new Error(t("Für den Harnold-Agent ist noch kein Anbieter eingerichtet. Einstellungen → Agent."));
  },

  defaultModel: () => nativeSettings.defaultModel(),
  runTurn: runNativeTurn,
};
