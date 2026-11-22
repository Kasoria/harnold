import ReactMarkdown from "react-markdown";

/**
 * Markdown for one-line previews: emphasis, code and links are rendered, block structure (headings, lists, quotes)
 * is flattened to flowing text so it fits into a truncated row.
 */
export function InlineMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      <ReactMarkdown
        allowedElements={["p", "strong", "em", "code", "del", "a", "br", "li"]}
        unwrapDisallowed
        components={{
          p: ({ children }) => <>{children}</>,
          li: ({ children }) => <>{children} </>,
          br: () => <> </>,
          a: ({ children }) => <span className="underline underline-offset-2">{children}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </span>
  );
}
