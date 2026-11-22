import { cn } from "@/lib/utils";

type SegmentedControlProps<OptionValue extends string> = {
  options: { value: OptionValue; label: React.ReactNode }[];
  value: OptionValue;
  onValueChange: (value: OptionValue) => void;
  className?: string;
};

/** Equal-width segments with a sliding indicator. */
export function SegmentedControl<OptionValue extends string>(props: SegmentedControlProps<OptionValue>) {
  const selectedIndex = Math.max(0, props.options.findIndex((option) => option.value === props.value));
  const segmentWidthPercent = 100 / props.options.length;

  return (
    <div role="tablist" className={cn("relative grid rounded-lg bg-muted p-0.5", props.className)} style={{ gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` }}>
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-md bg-card shadow-xs transition-transform duration-200 ease-out"
        style={{ width: `calc(${segmentWidthPercent}% - 2px)`, transform: `translateX(${selectedIndex * 100}%)` }}
      />
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === props.value}
          onClick={() => props.onValueChange(option.value)}
          className={cn(
            "relative z-10 px-3 py-1 text-[12px] font-medium transition-colors duration-200",
            option.value === props.value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
