import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TokenGate } from "./components/token-gate";
import { coreBaseUrl } from "./api";
import { allowEmbeddedOrigin } from "./lib/embedded-origins";
import "./styles.css";

// Desktop app with a remote Core: canvas and file previews are frames from that Core – allow them before the first render.
void (coreBaseUrl ? allowEmbeddedOrigin(coreBaseUrl) : Promise.resolve()).finally(() =>
  createRoot(document.getElementById("root")!).render(<TokenGate><App /></TokenGate>),
);
