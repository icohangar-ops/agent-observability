import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
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

const STORAGE_KEY = "agent-observability:date-range";
const PRESETS: Exclude<DateRangePreset, "custom">[] = ["all", "7d", "30d", "month"];

/** Serialize the active range into URLSearchParams (omitting the default "all"). */
function stateToSearch(state: DateRangeState): string {
  const params = new URLSearchParams();
  if (state.preset === "all") return "";
  params.set("range", state.preset);
  if (state.preset === "custom" && state.from && state.to) {
    params.set("from", state.from);
    params.set("to", state.to);
  }
  return params.toString();
}

function isPreset(value: string | null): value is Exclude<DateRangePreset, "custom"> {
  return value !== null && (PRESETS as string[]).includes(value);
}

function parseSearch(search: string): DateRangeState | null {
  const params = new URLSearchParams(search);
  const range = params.get("range");
  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;

  if (isPreset(range)) {
    return presetRange(range);
  }
  if (range === "custom" || (from && to)) {
    if (from && to) {
      return { preset: "custom", from, to };
    }
  }
  return null;
}

function parseStorage(): DateRangeState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DateRangeState>;
    if (parsed.preset && isPreset(parsed.preset)) {
      return presetRange(parsed.preset);
    }
    if (parsed.preset === "custom" && parsed.from && parsed.to) {
      return { preset: "custom", from: parsed.from, to: parsed.to };
    }
  } catch {
    // ignore malformed storage
  }
  return null;
}

function initialState(): DateRangeState {
  if (typeof window !== "undefined") {
    const fromUrl = parseSearch(window.location.search);
    if (fromUrl) return fromUrl;
    const fromStorage = parseStorage();
    if (fromStorage) return fromStorage;
  }
  return { preset: "all" };
}

const DateRangeContext = createContext<DateRangeContextValue | null>(null);

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DateRangeState>(initialState);
  const [location, navigate] = useLocation();
  const lastLocation = useRef(location);

  const selectPreset = useCallback(
    (preset: Exclude<DateRangePreset, "custom">) => {
      setState(presetRange(preset));
    },
    [],
  );

  const setCustomRange = useCallback((from: string, to: string) => {
    setState({ preset: "custom", from, to });
  }, []);

  // Persist to localStorage so a refresh restores the range even without a query string.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, [state]);

  // Keep the URL query string in sync with the active range. This runs both when the
  // range changes and when the path changes (wouter <Link> navigation drops the query),
  // so the filter stays shareable as the user moves between pages.
  useEffect(() => {
    if (typeof window === "undefined") return;
    lastLocation.current = location;
    const desired = stateToSearch(state);
    const current = window.location.search.replace(/^\?/, "");
    if (current === desired) return;
    navigate(`${location}${desired ? `?${desired}` : ""}`, { replace: true });
  }, [state, location, navigate]);

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
