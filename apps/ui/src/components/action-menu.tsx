import { Check, MoreHorizontal } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * One list of actions for an item, shown both as right-click menu and behind a "…" button.
 * Submenus (e.g. "Move to") are actions with `children`.
 */
export type MenuAction = {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onSelect?: () => void;
  destructive?: boolean;
  checked?: boolean;
  /** Draws a separator above this action. */
  separated?: boolean;
  hidden?: boolean;
  children?: MenuAction[];
};

const contentClassName =
  "z-50 max-h-(--radix-context-menu-content-available-height) min-w-[11rem] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";
const itemClassName =
  "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

type Primitives = typeof ContextMenuPrimitive | typeof DropdownMenuPrimitive;

function MenuItems({ actions, primitives }: { actions: MenuAction[]; primitives: Primitives }) {
  const { Item, Separator, Sub, SubTrigger, SubContent, Portal } = primitives;
  return actions
    .filter((action) => !action.hidden)
    .map((action) => {
      const ActionIcon = action.icon;
      const separator = action.separated ? <Separator className="-mx-1 my-1 h-px bg-border" /> : null;
      const content = (
        <>
          {ActionIcon ? <ActionIcon className={action.destructive ? "text-destructive" : "text-muted-foreground"} /> : <span className="size-4" />}
          <span className="truncate">{action.label}</span>
          {action.checked && <Check className="ml-auto size-3.5" />}
        </>
      );
      if (action.children) {
        return (
          <div key={action.label} className="contents">
            {separator}
            <Sub>
              <SubTrigger className={itemClassName}>{content}</SubTrigger>
              <Portal>
                <SubContent className={contentClassName}>
                  <MenuItems actions={action.children} primitives={primitives} />
                </SubContent>
              </Portal>
            </Sub>
          </div>
        );
      }
      return (
        <div key={action.label} className="contents">
          {separator}
          <Item className={cn(itemClassName, action.destructive && "text-destructive focus:text-destructive")} onSelect={action.onSelect}>
            {content}
          </Item>
        </div>
      );
    });
}

/** Right-click menu around any element. */
export function ActionContextMenu(props: { actions: MenuAction[]; children: React.ReactNode }) {
  return (
    <ContextMenuPrimitive.Root modal={false}>
      <ContextMenuPrimitive.Trigger asChild>{props.children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className={contentClassName}>
          <MenuItems actions={props.actions} primitives={ContextMenuPrimitive} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

/** Same actions behind a "…" button (visible on hover), for mouse users who don't right-click. */
export function ActionMenuButton(props: { actions: MenuAction[]; label: string; className?: string }) {
  return (
    <DropdownMenuPrimitive.Root modal={false}>
      <DropdownMenuPrimitive.Trigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label={props.label}
          title={props.label}
          onClick={(clickEvent) => clickEvent.stopPropagation()}
          className={cn(
            "flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 max-md:size-8",
            props.className,
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </span>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="start" className={contentClassName.replace("context-menu", "dropdown-menu")} onClick={(clickEvent) => clickEvent.stopPropagation()}>
          <MenuItems actions={props.actions} primitives={DropdownMenuPrimitive} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
