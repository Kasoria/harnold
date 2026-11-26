import { useEffect, useRef, useState } from "react";

const HEIGHT_REPORTER = `<script>(function(){function r(){parent.postMessage({harnoldFrameHeight:document.documentElement.scrollHeight},"*")}addEventListener("load",r);new ResizeObserver(r).observe(document.documentElement)})()</script>`;

/** Interactive HTML from an MCP tool: sandboxed (scripts yes, no access to Harnold), height follows the content. */
export function HtmlFrame({ html }: { html: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const reportedHeight = (event.data as { harnoldFrameHeight?: unknown } | null)?.harnoldFrameHeight;
      if (typeof reportedHeight === "number") setHeight(Math.min(Math.max(reportedHeight, 60), 900));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frameRef}
      title="MCP"
      sandbox="allow-scripts allow-forms allow-popups"
      srcDoc={html + HEIGHT_REPORTER}
      style={{ height }}
      className="w-full max-w-full rounded-lg border bg-white"
    />
  );
}

/** A tool text that is a complete HTML document (not a snippet inside prose). */
export const looksLikeHtmlDocument = (text: string) => /^\s*(<!doctype html|<html[\s>])/i.test(text);
