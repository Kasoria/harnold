import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectOption<OptionValue extends string> = { value: OptionValue; label: React.ReactNode };

/**
 * Choice among three or more options as a dropdown (two options stay a SegmentedControl).
 * "quiet" = borderless, for filters in toolbars and headers.
 */
export function OptionSelect<OptionValue extends string>(props: {
  options: SelectOption<OptionValue>[];
  value: OptionValue;
  onValueChange: (value: OptionValue) => void;
  quiet?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <Select value={props.value} onValueChange={(value) => props.onValueChange(value as OptionValue)}>
      <SelectTrigger
        size="sm"
        aria-label={props.ariaLabel}
        className={cn(props.quiet ? "h-7 border-0 bg-transparent px-2 text-[12px] shadow-none hover:bg-foreground/5" : "h-8 text-[13px]", props.className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align={props.quiet ? "end" : "start"}>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
