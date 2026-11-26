import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export function CopyButton({ readText, className, label }: { readText: () => string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={t("Kopieren")}
      className={cn("inline-flex items-center gap-1 rounded-md text-muted-foreground transition-colors hover:text-foreground", className)}
      onClick={() => {
        void navigator.clipboard.writeText(readText()).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {label && (copied ? t("Kopiert") : label)}
    </button>
  );
}

function CodeBlock(props: React.ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  return (
    <div className="group/code relative my-2">
      <pre ref={preRef} {...props} />
      <CopyButton
        readText={() => preRef.current?.innerText.replace(/\n$/, "") ?? ""}
        className="absolute top-1.5 right-1.5 bg-muted p-1.5 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown components={{ pre: CodeBlock }}>{text}</ReactMarkdown>
    </div>
  );
}
