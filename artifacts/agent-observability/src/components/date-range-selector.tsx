import { useState } from "react";
import { CalendarRange } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { format } from "date-fns";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDateRange, type DateRangePreset } from "@/lib/date-range";

const PRESET_OPTIONS: { value: Exclude<DateRangePreset, "custom">; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "month", label: "This month" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export function DateRangeSelector() {
  const { preset, from, to, label, selectPreset, setCustomRange } = useDateRange();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);

  const handlePresetChange = (value: string) => {
    selectPreset(value as Exclude<DateRangePreset, "custom">);
  };

  const openCustom = () => {
    setDraft(
      from && to ? { from: new Date(from), to: new Date(to) } : undefined,
    );
    setOpen(true);
  };

  const applyCustom = () => {
    if (draft?.from && draft?.to) {
      setCustomRange(format(draft.from, "yyyy-MM-dd"), format(draft.to, "yyyy-MM-dd"));
      setOpen(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Select value={preset === "custom" ? "" : preset} onValueChange={handlePresetChange}>
        <SelectTrigger className="w-[150px] h-9">
          <SelectValue placeholder="Select range">
            {preset === "custom" ? label : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {PRESET_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={preset === "custom" ? "default" : "outline"}
            size="sm"
            className="h-9"
            onClick={openCustom}
          >
            <CalendarRange className="size-4 mr-2" />
            {preset === "custom" ? label : "Custom"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="range"
            selected={draft}
            onSelect={setDraft}
            numberOfMonths={2}
            captionLayout="dropdown"
            defaultMonth={draft?.from}
          />
          <div className="flex items-center justify-between gap-2 border-t border-border p-3">
            <span className="text-xs text-muted-foreground">
              {draft?.from && draft?.to
                ? `${format(draft.from, "MMM d")} – ${format(draft.to, "MMM d, yyyy")}`
                : "Pick a start and end date"}
            </span>
            <Button size="sm" disabled={!draft?.from || !draft?.to} onClick={applyCustom}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
