import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** Icon button under a chat message; what it does is in the tooltip, so the action row stays short. */
export function MessageAction(props: { label: string; onClick: () => void; children: React.ReactNode; className?: string; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={props.label}
          disabled={props.disabled}
          onClick={props.onClick}
          className={cn("text-muted-foreground hover:text-foreground [&_svg]:size-3.5", props.className)}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{props.label}</TooltipContent>
    </Tooltip>
  );
}

export function CopyMessageAction(props: { readText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <MessageAction
      label={copied ? t("Kopiert") : t("Kopieren")}
      className={props.className}
      onClick={() => {
        void navigator.clipboard.writeText(props.readText()).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check /> : <Copy />}
    </MessageAction>
  );
}
