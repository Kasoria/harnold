import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { ChatMarkdown } from "./chat-markdown";
import { HtmlFrame, looksLikeHtmlDocument } from "./html-frame";
import type { ToolResultItem } from "./tool-group";

const MAX_TABLE_ROWS = 50;

/** JSON text of a tool result as an object/array, or undefined for plain text. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function DataTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <div className="max-h-72 overflow-auto rounded-md border">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-2 py-1 font-medium whitespace-nowrap">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t align-top">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="max-w-xs px-2 py-1 break-words">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonView({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
    const columns = [...new Set(value.flatMap((record) => Object.keys(record)))].slice(0, 8);
    const shownRows = value.slice(0, MAX_TABLE_ROWS);
    return (
      <div className="space-y-1">
        <DataTable columns={columns} rows={shownRows.map((record) => columns.map((column) => cellText(record[column])))} />
        {value.length > shownRows.length && <p className="text-[11px] text-muted-foreground">{t("{0} weitere Einträge", value.length - shownRows.length)}</p>}
      </div>
    );
  }
  if (isRecord(value) && Object.keys(value).length > 0) {
    return <DataTable columns={[t("Feld"), t("Wert")]} rows={Object.entries(value).map(([key, entryValue]) => [<span key={key} className="font-medium">{key}</span>, cellText(entryValue)])} />;
  }
  return <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>;
}

export function ToolResultImages({ toolResult }: { toolResult: ToolResultItem }) {
  if (!toolResult.images?.length && !toolResult.html?.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {toolResult.html?.map((htmlDocument, htmlIndex) => <HtmlFrame key={htmlIndex} html={htmlDocument} />)}
      {toolResult.images?.map((image, imageIndex) => (
        <img
          key={imageIndex}
          src={`data:${image.mediaType};base64,${image.data}`}
          alt=""
          className="max-h-80 max-w-full rounded-lg border object-contain"
        />
      ))}
    </div>
  );
}

/** Result of a tool call: MCP results as images, markdown or table (like the Claude desktop app), everything else as plain text. */
export function ToolResultView({ toolName, toolResult }: { toolName: string; toolResult: ToolResultItem }) {
  const isMcp = toolName.startsWith("mcp__");
  const content = toolResult.content?.trim() ?? "";
  const plainClass = cn("max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground", toolResult.isError && "text-destructive");
  if (!isMcp || toolResult.isError) {
    return <pre className={plainClass}>{content || t("(keine Ausgabe)")}</pre>;
  }
  const parsedJson = parseJson(content);
  const textIsHtml = looksLikeHtmlDocument(content);
  return (
    <div className="space-y-2">
      <ToolResultImages toolResult={toolResult} />
      {textIsHtml && <HtmlFrame html={content} />}
      {!content || textIsHtml ? (
        !toolResult.images?.length && !toolResult.html?.length && !textIsHtml && <pre className={plainClass}>{t("(keine Ausgabe)")}</pre>
      ) : parsedJson !== undefined ? (
        <JsonView value={parsedJson} />
      ) : (
        <div className="max-h-96 overflow-auto rounded-md bg-muted/50 p-2 text-[13px]">
          <ChatMarkdown text={content} />
        </div>
      )}
    </div>
  );
}
