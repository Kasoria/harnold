import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export type ComboboxOption = { value: string; label: string; description?: string };

/**
 * Select with a search field for lists that can grow (projects, environments, agents, channels).
 * The list is exactly as wide as the field; long descriptions are cut off.
 */
export function Combobox(props: {
  value: string;
  options: ComboboxOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  size?: "default" | "sm";
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [searchText, setSearchText] = React.useState("");
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const selectedOption = props.options.find((option) => option.value === props.value);

  const normalizedSearch = searchText.trim().toLowerCase();
  const visibleOptions = normalizedSearch
    ? props.options.filter((option) => option.label.toLowerCase().includes(normalizedSearch) || option.description?.toLowerCase().includes(normalizedSearch))
    : props.options;

  React.useEffect(() => setHighlightedIndex(0), [normalizedSearch]);
  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${highlightedIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const choose = (option: ComboboxOption) => {
    props.onValueChange(option.value);
    setOpen(false);
  };

  return (
    <PopoverPrimitive.Root
      modal
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setSearchText("");
          setHighlightedIndex(Math.max(0, props.options.findIndex((option) => option.value === props.value)));
        }
      }}
    >
      <PopoverPrimitive.Trigger asChild disabled={props.disabled}>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          data-size={props.size ?? "default"}
          className={cn(
            "flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 dark:bg-input/30 dark:hover:bg-input/50",
            props.className,
          )}
        >
          <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>{selectedOption?.label ?? props.placeholder ?? ""}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[var(--radix-popover-trigger-width)] min-w-48 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          onOpenAutoFocus={(focusEvent) => {
            focusEvent.preventDefault();
            (focusEvent.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
        >
          <div className="flex items-center gap-2 border-b px-2.5">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={searchText}
              placeholder={props.searchPlaceholder ?? t("Suchen …")}
              className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(changeEvent) => setSearchText(changeEvent.target.value)}
              onKeyDown={(keyboardEvent) => {
                if (keyboardEvent.key === "ArrowDown" || keyboardEvent.key === "ArrowUp") {
                  keyboardEvent.preventDefault();
                  if (!visibleOptions.length) return;
                  const step = keyboardEvent.key === "ArrowDown" ? 1 : -1;
                  setHighlightedIndex((previous) => (previous + step + visibleOptions.length) % visibleOptions.length);
                } else if (keyboardEvent.key === "Enter") {
                  keyboardEvent.preventDefault();
                  const highlightedOption = visibleOptions[highlightedIndex];
                  if (highlightedOption) choose(highlightedOption);
                }
              }}
            />
          </div>
          <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {visibleOptions.length === 0 && <div className="px-2 py-3 text-center text-[13px] text-muted-foreground">{t("Keine Treffer.")}</div>}
            {visibleOptions.map((option, optionIndex) => (
              <button
                key={option.value}
                type="button"
                role="option"
                data-index={optionIndex}
                aria-selected={option.value === props.value}
                className={cn("flex w-full min-w-0 items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-left text-sm relative", optionIndex === highlightedIndex && "bg-accent text-accent-foreground")}
                onMouseEnter={() => setHighlightedIndex(optionIndex)}
                onClick={() => choose(option)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.description && <span className="block truncate text-[12px] text-muted-foreground">{option.description}</span>}
                </span>
                {option.value === props.value && <CheckIcon className="absolute right-2 size-4" />}
              </button>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
