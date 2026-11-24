import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TokenGate } from "./components/token-gate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<TokenGate><App /></TokenGate>);
