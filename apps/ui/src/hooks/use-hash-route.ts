import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** Top-level screens. "workspace" = chat + workspace of the active project. */
export type ScreenName = "today" | "workspace" | "tasks" | "channels" | "memory" | "integrations" | "design" | "environments" | "settings";
export type HashRoute = { screen: ScreenName; section: string | null; itemId: string | null };

const screenNames: ScreenName[] = ["today", "workspace", "tasks", "channels", "memory", "integrations", "design", "environments", "settings"];

function parseHash(hash: string): HashRoute {
  const [screenSegment, ...restSegments] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const screen = screenNames.includes(screenSegment as ScreenName) ? (screenSegment as ScreenName) : "workspace";
  if (screen === "workspace") return { screen, section: null, itemId: null };
  // tasks/<id>, channels/<id>, design/<id>, memory/<scope>/<path…>, integrations/<tab>/<id>, settings/<section>
  if (screen === "integrations" || screen === "memory") return { screen, section: restSegments[0] || null, itemId: restSegments.slice(1).join("/") || null };
  if (screen === "settings") return { screen, section: restSegments[0] || null, itemId: null };
  return { screen, section: null, itemId: restSegments.join("/") || null };
}

/** Minimal hash router: back/forward work, routes are linkable. */
export function useHashRoute() {
  const [route, setRoute] = useState<HashRoute>(() => {
    // A fresh open (no hash) starts on "Heute".
    if (!window.location.hash) history.replaceState(null, "", "#/today");
    return parseHash(window.location.hash);
  });

  /** Screen changes cross-fade via the View Transitions API; changes within a screen apply instantly. */
  const currentScreenRef = useRef(route.screen);
  const applyRoute = useCallback((nextRoute: HashRoute) => {
    const screenChanges = currentScreenRef.current !== nextRoute.screen;
    currentScreenRef.current = nextRoute.screen;
    if (screenChanges && document.startViewTransition) document.startViewTransition(() => flushSync(() => setRoute(nextRoute)));
    else setRoute(nextRoute);
  }, []);

  useEffect(() => {
    const handleHashChange = () => applyRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [applyRoute]);

  const navigate = useCallback((path: string) => {
    const nextHash = path === "/" || path === "" ? "" : `#${path.startsWith("/") ? path : `/${path}`}`;
    if (window.location.hash === nextHash || (!nextHash && !window.location.hash)) return;
    if (nextHash) window.location.hash = nextHash;
    else {
      history.pushState(null, "", window.location.pathname + window.location.search);
      applyRoute(parseHash(""));
    }
  }, [applyRoute]);

  return { route, navigate };
}

export const routePath = (...segments: (string | null | undefined)[]) =>
  `/${segments.filter((segment): segment is string => Boolean(segment)).map(encodeURIComponent).join("/")}`;
