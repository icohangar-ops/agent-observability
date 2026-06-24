import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { format, startOfMonth, subDays } from "date-fns";
import type {
  TraceList,
  TraceSummary,
  TraceCostBreakdown,
  TraceCostGroup,
} from "@workspace/api-client-react";

// Only the data hooks are mocked. Crucially, this file does NOT mock
// `@/lib/date-range` or `wouter`, so the real DateRangeProvider and the real
// Traces page each run their own URL-sync effect against the *same* query
// string — exactly the cold-load race the test needs to exercise.
const useListTraces = vi.fn();
const useGetTraceSummary = vi.fn();
const useGetTraceCostBreakdown = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListTraces: (...args: unknown[]) => useListTraces(...args),
  useGetTraceSummary: (...args: unknown[]) => useGetTraceSummary(...args),
  useGetTraceCostBreakdown: (...args: unknown[]) => useGetTraceCostBreakdown(...args),
}));

import Traces from "./traces";
import { DateRangeProvider, useDateRange } from "@/lib/date-range";

// A fixed custom window the tests apply via the provider's setCustomRange
// surface — the same call the date picker makes when a user picks from/to.
const CUSTOM_FROM = "2026-01-05";
const CUSTOM_TO = "2026-02-10";

// A minimal stand-in for the real DateRangeSelector: it drives the *same*
// `selectPreset` / `setCustomRange` surfaces the provider exposes, so a test
// can change the date range mid-session exactly the way the date picker would,
// while Traces runs its own URL-sync effect against the same query string.
function PresetControls() {
  const { selectPreset, setCustomRange } = useDateRange();
  return (
    <>
      <button
        type="button"
        data-testid="apply-7d"
        onClick={() => selectPreset("7d")}
      >
        7d
      </button>
      <button
        type="button"
        data-testid="apply-30d"
        onClick={() => selectPreset("30d")}
      >
        30d
      </button>
      <button
        type="button"
        data-testid="apply-month"
        onClick={() => selectPreset("month")}
      >
        This month
      </button>
      <button
        type="button"
        data-testid="apply-custom"
        onClick={() => setCustomRange(CUSTOM_FROM, CUSTOM_TO)}
      >
        Custom
      </button>
      <button
        type="button"
        data-testid="apply-all"
        onClick={() => selectPreset("all")}
      >
        All time
      </button>
    </>
  );
}

type QueryResult<T> = { data: T | undefined; isLoading: boolean };

function tracesResult(over: Partial<QueryResult<TraceList>>): QueryResult<TraceList> {
  return { data: { noData: false, spans: [] }, isLoading: false, ...over };
}

function summaryResult(
  over: Partial<QueryResult<TraceSummary>>,
): QueryResult<TraceSummary> {
  return {
    data: {
      noData: false,
      spanCount: 0,
      errorCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      avgLatencyMs: 0,
    },
    isLoading: false,
    ...over,
  };
}

function group(over: Partial<TraceCostGroup> & { key: string }): TraceCostGroup {
  return { cost: 1, spanCount: 1, totalTokens: 10, costShare: 1, ...over };
}

function breakdownResult(
  over: Partial<QueryResult<TraceCostBreakdown>>,
): QueryResult<TraceCostBreakdown> {
  return {
    data: {
      noData: false,
      byModel: [group({ key: "gpt-4o" })],
      byApp: [group({ key: "support-bot" })],
      byDepartment: [group({ key: "Engineering" })],
    },
    isLoading: false,
    ...over,
  };
}

// The most recent params object handed to the traces list query; this is what
// the page actually fetches with, so it proves both the active group and the
// date window reach the API.
function lastListParams(): Record<string, unknown> {
  const call = useListTraces.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

const DATE_STORAGE_KEY = "agent-observability:date-range";
const VIEW_STORAGE_KEY = "agent-observability:traces-view";

describe("Traces + DateRangeProvider shared link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useListTraces.mockReturnValue(tracesResult({}));
    useGetTraceSummary.mockReturnValue(summaryResult({}));
    useGetTraceCostBreakdown.mockReturnValue(breakdownResult({}));
  });

  afterEach(() => {
    // Reset the URL so a test's query string never leaks into the next one.
    window.history.replaceState({}, "", "/traces");
    window.localStorage.clear();
  });

  it("restores both the date range and the breakdown filter from a cold shared URL without clobbering each other", async () => {
    // A fresh tab opening a shared link: both the date-range param (range=7d)
    // and the breakdown params (group=model&gval=gpt-4o) are present at mount,
    // and there is nothing remembered in localStorage to fall back on.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?range=7d&group=model&gval=gpt-4o");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // The breakdown filter is active purely from the URL.
    const chip = await screen.findByTestId("active-group-filter");
    expect(chip).toHaveTextContent("Model:");
    expect(chip).toHaveTextContent("gpt-4o");
    expect(screen.getByTestId("breakdown-row-gpt-4o")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The date range is applied: range=7d resolves to a concrete from/to window
    // and reaches the query alongside the group filter.
    const today = new Date();
    const expectedFrom = format(subDays(today, 6), "yyyy-MM-dd");
    const expectedTo = format(today, "yyyy-MM-dd");
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(expectedFrom);
      expect(params.to).toBe(expectedTo);
    });

    // After both effects settle, neither has stripped the other's params from
    // the shared URL: the range and the breakdown filter all survive together.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("7d");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Give the effects extra ticks to prove the URL has truly settled rather
    // than ping-ponging — the params must still all be present.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("7d");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
  });

  it("does not write date-range params for an all-time range while keeping the breakdown filter on a shared link", async () => {
    // No range param means "all time": the date-range effect must leave the
    // query string's group/gval untouched and must not inject range/from/to.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?group=app&gval=support-bot");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    const chip = await screen.findByTestId("active-group-filter");
    expect(chip).toHaveTextContent("support-bot");

    await waitFor(() => {
      const params = lastListParams();
      expect(params.app).toBe("support-bot");
      // All-time means no date window is sent to the API.
      expect(params.from).toBeUndefined();
      expect(params.to).toBeUndefined();
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const search = new URLSearchParams(window.location.search);
    expect(search.get("group")).toBe("app");
    expect(search.get("gval")).toBe("support-bot");
    // The date-range effect must not have added range/from/to for all-time.
    expect(search.get("range")).toBeNull();
    expect(search.get("from")).toBeNull();
    expect(search.get("to")).toBeNull();
  });

  it("strips the date range but keeps the breakdown filter when switching back to all time", async () => {
    // Mid-session: open on a concrete range (7d) so range/from/to are live in
    // the URL and the list query, with nothing in localStorage to seed it.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?range=7d");

    render(
      <DateRangeProvider>
        <PresetControls />
        <Traces />
      </DateRangeProvider>,
    );

    const today = new Date();
    const expectedFrom = format(subDays(today, 6), "yyyy-MM-dd");
    const expectedTo = format(today, "yyyy-MM-dd");

    // The 7d window reaches the list query at mount.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.from).toBe(expectedFrom);
      expect(params.to).toBe(expectedTo);
    });

    // 1) Activate a breakdown filter by clicking a row.
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });
    // Both the range and the group are live together before the switch.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(expectedFrom);
      expect(params.to).toBe(expectedTo);
    });

    // 2) Switch the date range back to "All time" via the provider surface.
    fireEvent.click(screen.getByTestId("apply-all"));

    // The all-time list query drops from/to but keeps the group dimension.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBeUndefined();
      expect(params.to).toBeUndefined();
    });

    // The URL strips range/from/to while leaving the breakdown's group/gval.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBeNull();
      expect(search.get("from")).toBeNull();
      expect(search.get("to")).toBeNull();
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks must not bring range/from/to back or drop the group (no ping-pong).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBeNull();
    expect(settled.get("from")).toBeNull();
    expect(settled.get("to")).toBeNull();
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
  });

  it("rewrites the date window but keeps the breakdown filter when switching between two concrete presets", async () => {
    // Mid-session: open on a concrete 7d range so range/from/to are live in the
    // URL and the list query, with nothing in localStorage to seed it.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?range=7d");

    render(
      <DateRangeProvider>
        <PresetControls />
        <Traces />
      </DateRangeProvider>,
    );

    const today = new Date();
    const from7d = format(subDays(today, 6), "yyyy-MM-dd");
    const to7d = format(today, "yyyy-MM-dd");
    const from30d = format(subDays(today, 29), "yyyy-MM-dd");
    const to30d = format(today, "yyyy-MM-dd");

    // The 7d window reaches the list query at mount.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.from).toBe(from7d);
      expect(params.to).toBe(to7d);
    });

    // 1) Activate a breakdown filter by clicking a row.
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });
    // Both the 7d range and the group are live together before the switch.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(from7d);
      expect(params.to).toBe(to7d);
    });

    // 2) Switch directly to the 30d preset via the provider surface.
    fireEvent.click(screen.getByTestId("apply-30d"));

    // The list query updates from/to to the 30d window but keeps the group.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(from30d);
      expect(params.to).toBe(to30d);
    });

    // The URL rewrites range/from/to to the 30d window while leaving group/gval.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("30d");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks must not revert the range or drop the group (no ping-pong).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("30d");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
    const settledParams = lastListParams();
    expect(settledParams.model).toBe("gpt-4o");
    expect(settledParams.from).toBe(from30d);
    expect(settledParams.to).toBe(to30d);
  });

  it("rewrites the date window to the month preset but keeps the breakdown filter", async () => {
    // Mid-session: open on a concrete 7d range so range/from/to are live in the
    // URL and the list query, with nothing in localStorage to seed it.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?range=7d");

    render(
      <DateRangeProvider>
        <PresetControls />
        <Traces />
      </DateRangeProvider>,
    );

    const today = new Date();
    const from7d = format(subDays(today, 6), "yyyy-MM-dd");
    const to7d = format(today, "yyyy-MM-dd");
    const fromMonth = format(startOfMonth(today), "yyyy-MM-dd");
    const toMonth = format(today, "yyyy-MM-dd");

    // The 7d window reaches the list query at mount.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.from).toBe(from7d);
      expect(params.to).toBe(to7d);
    });

    // 1) Activate a breakdown filter by clicking a row.
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });
    // Both the 7d range and the group are live together before the switch.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(from7d);
      expect(params.to).toBe(to7d);
    });

    // 2) Switch to the "This month" preset via the provider surface.
    fireEvent.click(screen.getByTestId("apply-month"));

    // The list query updates from/to to the month window but keeps the group.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(fromMonth);
      expect(params.to).toBe(toMonth);
    });

    // The URL records range=month while leaving group/gval intact. (The month
    // preset is derived, so its concrete from/to live in the query, not the URL.)
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("month");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks must not revert the range or drop the group (no ping-pong).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("month");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
    const settledParams = lastListParams();
    expect(settledParams.model).toBe("gpt-4o");
    expect(settledParams.from).toBe(fromMonth);
    expect(settledParams.to).toBe(toMonth);
  });

  it("writes a custom from/to window to the URL but keeps the breakdown filter", async () => {
    // Mid-session: open on a concrete 7d range so range/from/to are live in the
    // URL and the list query, with nothing in localStorage to seed it.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?range=7d");

    render(
      <DateRangeProvider>
        <PresetControls />
        <Traces />
      </DateRangeProvider>,
    );

    const today = new Date();
    const from7d = format(subDays(today, 6), "yyyy-MM-dd");
    const to7d = format(today, "yyyy-MM-dd");

    // The 7d window reaches the list query at mount.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.from).toBe(from7d);
      expect(params.to).toBe(to7d);
    });

    // 1) Activate a breakdown filter by clicking a row.
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });
    // Both the 7d range and the group are live together before the switch.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(from7d);
      expect(params.to).toBe(to7d);
    });

    // 2) Apply a custom from/to range via the provider surface.
    fireEvent.click(screen.getByTestId("apply-custom"));

    // The list query updates from/to to the custom window but keeps the group.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(CUSTOM_FROM);
      expect(params.to).toBe(CUSTOM_TO);
    });

    // A custom range writes range=custom plus its concrete from/to to the URL,
    // all while leaving group/gval intact.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("custom");
      expect(search.get("from")).toBe(CUSTOM_FROM);
      expect(search.get("to")).toBe(CUSTOM_TO);
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks must not revert the range or drop the group (no ping-pong).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("custom");
    expect(settled.get("from")).toBe(CUSTOM_FROM);
    expect(settled.get("to")).toBe(CUSTOM_TO);
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
    const settledParams = lastListParams();
    expect(settledParams.model).toBe("gpt-4o");
    expect(settledParams.from).toBe(CUSTOM_FROM);
    expect(settledParams.to).toBe(CUSTOM_TO);
  });

  it("persists the restored range and group so they outlive the shared link", async () => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?range=30d&group=department&gval=Engineering");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    await screen.findByTestId("active-group-filter");

    // Both providers persist their own slice of state to localStorage so the
    // view survives <Link> navigation (which drops the query string).
    await waitFor(() => {
      const dateStored = JSON.parse(
        window.localStorage.getItem(DATE_STORAGE_KEY) ?? "{}",
      );
      expect(dateStored.preset).toBe("30d");

      const viewStored = JSON.parse(
        window.localStorage.getItem(VIEW_STORAGE_KEY) ?? "{}",
      );
      expect(viewStored.group).toEqual({
        dimension: "department",
        value: "Engineering",
      });
    });
  });

  it("keeps both params in the live URL when the date range is changed first, then a breakdown row clicked", async () => {
    // Mid-session, not a cold load: start on an all-time, unfiltered page so the
    // query string is empty and there is nothing in localStorage to seed it.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces");

    render(
      <DateRangeProvider>
        <PresetControls />
        <Traces />
      </DateRangeProvider>,
    );

    // 1) Change the date range via the real provider surface.
    fireEvent.click(screen.getByTestId("apply-7d"));
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("range")).toBe("7d");
    });

    // 2) Then click a breakdown row.
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));

    const today = new Date();
    const expectedFrom = format(subDays(today, 6), "yyyy-MM-dd");
    const expectedTo = format(today, "yyyy-MM-dd");

    // Both the date window and the group reach the list query simultaneously.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(expectedFrom);
      expect(params.to).toBe(expectedTo);
    });

    // Neither effect has stripped the other's params from the URL.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("7d");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // The URL has truly settled — extra ticks must not drop a param (no ping-pong).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("7d");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
  });

  it("keeps both params in the live URL when a breakdown row is clicked first, then the date range changed", async () => {
    // The reverse order of the previous test: the two URL-sync effects fire in
    // the opposite sequence, which is the other way a regression could drop one.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces");

    render(
      <DateRangeProvider>
        <PresetControls />
        <Traces />
      </DateRangeProvider>,
    );

    // 1) Click a breakdown row first (still all-time at this point).
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // 2) Then change the date range.
    fireEvent.click(screen.getByTestId("apply-7d"));

    const today = new Date();
    const expectedFrom = format(subDays(today, 6), "yyyy-MM-dd");
    const expectedTo = format(today, "yyyy-MM-dd");

    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(expectedFrom);
      expect(params.to).toBe(expectedTo);
    });

    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("7d");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("7d");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
  });
});
