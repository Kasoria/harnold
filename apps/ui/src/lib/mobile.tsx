import { createContext, useContext, useSyncExternalStore } from "react";
import { ChevronLeft, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** Phones and narrow windows: below Tailwind's `md` breakpoint. */
const mobileMediaQuery = window.matchMedia("(max-width: 767px)");

const subscribeToMobileQuery = (onChange: () => void) => {
  mobileMediaQuery.addEventListener("change", onChange);
  return () => mobileMediaQuery.removeEventListener("change", onChange);
};

export function useIsMobile() {
  return useSyncExternalStore(subscribeToMobileQuery, () => mobileMediaQuery.matches);
}

/** Lets headers deep in the tree open the slide-in navigation on mobile. */
export const MobileNavContext = createContext<{ openNavigation: () => void } | null>(null);

/** Hamburger (or back arrow) at the start of a header; renders nothing on desktop. */
export function MobileNavButton(props: { onBack?: (() => void) | null; backLabel?: string; className?: string }) {
  const mobileNavigation = useContext(MobileNavContext);
  const isMobile = useIsMobile();
  if (!isMobile || !mobileNavigation) return null;
  if (props.onBack)
    return (
      <Button variant="ghost" size="icon" className={cn("-ml-2 size-9 shrink-0", props.className)} onClick={props.onBack} aria-label={props.backLabel ?? t("Zurück")}>
        <ChevronLeft className="size-5" />
      </Button>
    );
  return (
    <Button variant="ghost" size="icon" className={cn("-ml-2 size-9 shrink-0", props.className)} onClick={mobileNavigation.openNavigation} aria-label={t("Navigation öffnen")}>
      <Menu className="size-5" />
    </Button>
  );
}
