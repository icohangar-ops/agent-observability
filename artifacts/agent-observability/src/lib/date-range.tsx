import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { format, startOfMonth, subDays } from "date-fns";

export type DateRangePreset = "all" | "7d" | "30d" | "month" | "custom";

export interface DateRangeParams {
  from?: string;
  to?: string;
}

interface DateRangeState {
  preset: DateRangePreset;
  from?: string;
  to?: string;
}

interface DateRangeContextValue {
  preset: DateRangePreset;
  from?: string;
  to?: string;
  /** Query params for the API hooks. `undefined` means no filtering (all time). */
  params: DateRangeParams | undefined;
  /** Human-readable description of the active window. */
  label: string;
  selectPreset: (preset: Exclude<DateRangePreset, "custom">) => void;
  setCustomRange: (from: string, to: string) => void;
}

const fmt = (d: Date) => format(d, "yyyy-MM-dd");

function presetRange(preset: Exclude<DateRangePreset, "custom">): DateRangeState {
  const today = new Date();
  switch (preset) {
    case "all":
      return { preset: "all" };
    case "7d":
      return { preset: "7d", from: fmt(subDays(today, 6)), to: fmt(today) };
    case "30d":
      return { preset: "30d", from: fmt(subDays(today, 29)), to: fmt(today) };
    case "month":
      return { preset: "month", from: fmt(startOfMonth(today)), to: fmt(today) };
  }
}

function describe(state: DateRangeState): string {
  switch (state.preset) {
    case "all":
      return "All time";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "month":
      return "This month";
    case "custom":
      if (state.from && state.to) {
        return `${format(new Date(state.from), "MMM d")} – ${format(
          new Date(state.to),
          "MMM d, yyyy",
        )}`;
      }
      return "Custom range";
  }
}

const DateRangeContext = createContext<DateRangeContextValue | null>(null);

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DateRangeState>({ preset: "all" });

  const selectPreset = useCallback(
    (preset: Exclude<DateRangePreset, "custom">) => {
      setState(presetRange(preset));
    },
    [],
  );

  const setCustomRange = useCallback((from: string, to: string) => {
    setState({ preset: "custom", from, to });
  }, []);

  const value = useMemo<DateRangeContextValue>(() => {
    const params =
      state.from || state.to
        ? {
            ...(state.from ? { from: state.from } : {}),
            ...(state.to ? { to: state.to } : {}),
          }
        : undefined;
    return {
      preset: state.preset,
      from: state.from,
      to: state.to,
      params,
      label: describe(state),
      selectPreset,
      setCustomRange,
    };
  }, [state, selectPreset, setCustomRange]);

  return <DateRangeContext.Provider value={value}>{children}</DateRangeContext.Provider>;
}

export function useDateRange(): DateRangeContextValue {
  const ctx = useContext(DateRangeContext);
  if (!ctx) {
    throw new Error("useDateRange must be used within a DateRangeProvider");
  }
  return ctx;
}
