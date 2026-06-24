import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { format, subDays } from "date-fns";
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
import { DateRangeProvider } from "@/lib/date-range";

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
});
