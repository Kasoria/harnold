import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { accessToken, coreBaseUrl } from "@/api";
import { t } from "@/lib/i18n";

type GateState = "checking" | "locked" | "open";

/** Server mode with HARNOLD_TOKEN: asks for the token once, keeps it in localStorage. */
export function TokenGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [tokenInput, setTokenInput] = useState("");
  const [failed, setFailed] = useState(false);

  const check = async (token: string): Promise<boolean> => {
    try {
      const response = await fetch(`${coreBaseUrl}/api/auth/check`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      return response.ok;
    } catch {
      // Core unreachable: let the app show its own connection error.
      return true;
    }
  };

  useEffect(() => {
    void check(accessToken).then((isOk) => setState(isOk ? "open" : "locked"));
  }, []);

  if (state === "checking") return null;
  if (state === "open") return <>{children}</>;

  const submit = async () => {
    if (!(await check(tokenInput.trim()))) return setFailed(true);
    localStorage.setItem("harnold.token", tokenInput.trim());
    location.reload();
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <form className="flex w-80 flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <h1 className="text-lg font-medium">Harnold</h1>
        <p className="text-sm text-muted-foreground">{t("Dieser Server ist geschützt. Gib das Zugriffs-Token ein.")}</p>
        <Input type="password" autoFocus value={tokenInput} placeholder={t("Zugriffs-Token")} onChange={(event) => { setTokenInput(event.target.value); setFailed(false); }} />
        {failed && <p className="text-sm text-destructive">{t("Token ungültig.")}</p>}
        <Button type="submit" disabled={!tokenInput.trim()}>{t("Anmelden")}</Button>
      </form>
    </div>
  );
}
