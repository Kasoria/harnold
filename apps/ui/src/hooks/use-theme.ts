import { useEffect, useRef, useState } from "react";
import { safeStorage } from "@/lib/storage";

export type ThemePreference = "system" | "light" | "dark";

const darkMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function useTheme() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    (safeStorage.getItem("harnold.theme") as ThemePreference | null) ?? "system",
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(darkMediaQuery.matches);

  useEffect(() => {
    const handleChange = (changeEvent: MediaQueryListEvent) => setSystemPrefersDark(changeEvent.matches);
    darkMediaQuery.addEventListener("change", handleChange);
    return () => darkMediaQuery.removeEventListener("change", handleChange);
  }, []);

  const isFirstApplication = useRef(true);
  const resolvedTheme = themePreference === "system" ? (systemPrefersDark ? "dark" : "light") : themePreference;

  useEffect(() => {
    const rootElement = document.documentElement;
    const themeIsChanging = rootElement.classList.contains("dark") !== (resolvedTheme === "dark");
    if (themeIsChanging && !isFirstApplication.current) {
      rootElement.classList.add("theme-transition");
      window.setTimeout(() => rootElement.classList.remove("theme-transition"), 260);
    }
    isFirstApplication.current = false;
    rootElement.classList.toggle("dark", resolvedTheme === "dark");
    safeStorage.setItem("harnold.theme", themePreference);
  }, [resolvedTheme, themePreference]);

  return { themePreference, setThemePreference, resolvedTheme };
}
