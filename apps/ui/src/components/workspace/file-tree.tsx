import { useState } from "react";
import { AtSign, ChevronRight, File, Folder } from "lucide-react";
import type { FileNode } from "@/types";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type FileTreeProps = {
  nodes: FileNode[];
  selectedPath: string | null;
  onSelect: (filePath: string) => void;
  onReference: (filePath: string) => void;
  depth?: number;
};

const rowClassName =
  "group/file flex h-6 w-full items-center gap-1.5 rounded-md pr-1 text-left text-[12.5px] transition-colors duration-150 hover:bg-foreground/5";

function DirectoryNode(props: FileTreeProps & { node: FileNode }) {
  const depth = props.depth ?? 0;
  const [open, setOpen] = useState(depth === 0);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={rowClassName} style={{ paddingLeft: 4 + depth * 12 }}>
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{props.node.name}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-animated">
        <FileTree {...props} nodes={props.node.children ?? []} depth={depth + 1} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function FileTree(props: FileTreeProps) {
  const depth = props.depth ?? 0;
  return (
    <ul>
      {props.nodes.map((fileNode) => (
        <li key={fileNode.path}>
          {fileNode.type === "directory" ? (
            <DirectoryNode {...props} node={fileNode} />
          ) : (
            <button
              className={cn(rowClassName, fileNode.path === props.selectedPath && "bg-foreground/[0.07] font-medium")}
              style={{ paddingLeft: 4 + depth * 12 + 16 }}
              onClick={() => props.onSelect(fileNode.path)}
            >
              <File className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{fileNode.name}</span>
              <span
                role="button"
                tabIndex={0}
                title="Im Chat referenzieren"
                aria-label="Im Chat referenzieren"
                onClick={(clickEvent) => {
                  clickEvent.stopPropagation();
                  props.onReference(fileNode.path);
                }}
                onKeyDown={(keyboardEvent) => {
                  if (keyboardEvent.key === "Enter") {
                    keyboardEvent.stopPropagation();
                    props.onReference(fileNode.path);
                  }
                }}
                className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/file:opacity-100 hover:bg-foreground/10 hover:text-foreground"
              >
                <AtSign className="size-3" />
              </span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
