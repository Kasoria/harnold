import type { AgentBackendId } from "@/types";
import { useUnitModelLabel } from "@/lib/model-sources";

/**
 * Appends the unit's own program and model to a list row ("· Codex · gpt-5"). Rendered as a suffix so lists only
 * grow when something was actually chosen – inherited rows stay one line.
 */
export function UnitModelLabel(props: { backendId: AgentBackendId | null; model: string | null }) {
  const label = useUnitModelLabel(props.backendId, props.model);
  return label ? <> · {label}</> : null;
}
