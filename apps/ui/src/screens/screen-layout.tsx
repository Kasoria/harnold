import { cn } from "@/lib/utils";

/** Full page for a top-level feature: header (title, description, actions) + content. */
export function ScreenLayout(props: { title: string; description?: string; actions?: React.ReactNode; tabs?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className="flex h-full min-w-0 animate-in flex-col bg-background fade-in duration-200">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
        <h1 className="text-[14px] font-semibold">{props.title}</h1>
        {props.description && <p className="hidden truncate text-[12.5px] text-muted-foreground md:block">{props.description}</p>}
        {props.tabs && <div className="ml-2">{props.tabs}</div>}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">{props.actions}</div>
      </header>
      <div className={cn("min-h-0 flex-1", props.className)}>{props.children}</div>
    </section>
  );
}

/** List on the left, detail on the right – the standard layout for collections. */
export function MasterDetail(props: { list: React.ReactNode; detail: React.ReactNode; listClassName?: string }) {
  return (
    <div className="flex h-full min-h-0">
      <div className={cn("w-80 shrink-0 overflow-y-auto border-r p-2", props.listClassName)}>{props.list}</div>
      <div className="min-w-0 flex-1 overflow-y-auto">{props.detail}</div>
    </div>
  );
}

export function ListRow(props: { selected: boolean; onSelect: () => void; leading?: React.ReactNode; trailing?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          props.onSelect();
        }
      }}
      className={cn(
        "flex w-full cursor-default items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        props.selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
      )}
    >
      {props.leading && (
        <div className="shrink-0" onClick={(clickEvent) => clickEvent.stopPropagation()}>
          {props.leading}
        </div>
      )}
      <div className="min-w-0 flex-1">{props.children}</div>
      {props.trailing && (
        <div className="shrink-0" onClick={(clickEvent) => clickEvent.stopPropagation()}>
          {props.trailing}
        </div>
      )}
    </div>
  );
}

/** Centered placeholder for an empty list or nothing selected. */
export function EmptyState(props: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-60 animate-in items-center justify-center p-8 text-center fade-in duration-200">
      <div className="max-w-sm">
        <h2 className="text-[14px] font-medium">{props.title}</h2>
        {props.description && <p className="mt-1.5 text-[13px] text-muted-foreground">{props.description}</p>}
        {props.action && <div className="mt-4 flex justify-center gap-2">{props.action}</div>}
      </div>
    </div>
  );
}

/** Detail pane wrapper with its own header line. */
export function DetailPane(props: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; detailKey: string }) {
  return (
    <div key={props.detailKey} className="mx-auto w-full max-w-2xl min-w-0 animate-in px-6 py-5 fade-in slide-in-from-right-1 duration-200">
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{props.title}</h2>
          {props.subtitle && <div className="mt-0.5 text-[12.5px] text-muted-foreground">{props.subtitle}</div>}
        </div>
        {props.actions && <div className="flex shrink-0 items-center gap-1.5">{props.actions}</div>}
      </div>
      {props.children}
    </div>
  );
}
