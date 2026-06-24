import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  TraceList,
  TraceSummary,
  TraceCostBreakdown,
  TraceCostGroup,
} from "@workspace/api-client-react";

const useListTraces = vi.fn();
const useGetTraceSummary = vi.fn();
const useGetTraceCostBreakdown = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListTraces: (...args: unknown[]) => useListTraces(...args),
  useGetTraceSummary: (...args: unknown[]) => useGetTraceSummary(...args),
  useGetTraceCostBreakdown: (...args: unknown[]) => useGetTraceCostBreakdown(...args),
}));

vi.mock("@/lib/date-range", () => ({
  useDateRange: () => ({
    preset: "all" as const,
    params: undefined,
    label: "All time",
    selectPreset: vi.fn(),
    setCustomRange: vi.fn(),
  }),
}));

// A single, stable navigate spy so tests can assert how the page reflects the
// active group in the URL (a fresh vi.fn() per render would be unobservable).
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("wouter", () => ({
  useLocation: () => ["/traces", navigate],
}));

import Traces from "./traces";

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

function breakdownResult(
  over: Partial<QueryResult<TraceCostBreakdown>>,
): QueryResult<TraceCostBreakdown> {
  return {
    data: { noData: false, byModel: [], byApp: [], byDepartment: [] },
    isLoading: false,
    ...over,
  };
}

describe("Traces page non-table states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGetTraceSummary.mockReturnValue(summaryResult({}));
    useGetTraceCostBreakdown.mockReturnValue(breakdownResult({}));
  });

  it("shows the 'No traces yet' message when the API reports noData", () => {
    useListTraces.mockReturnValue(
      tracesResult({ data: { noData: true, spans: [] } }),
    );

    render(<Traces />);

    expect(screen.getByText("No traces yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Datadog LLM Observability has no agent traces/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("No spans match your filters")).not.toBeInTheDocument();
  });

  it("shows the 'No spans match your filters' message when there are zero spans but data exists", () => {
    useListTraces.mockReturnValue(
      tracesResult({ data: { noData: false, spans: [] } }),
    );

    render(<Traces />);

    expect(screen.getByText("No spans match your filters")).toBeInTheDocument();
    expect(
      screen.getByText(/Try a different span kind/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("No traces yet")).not.toBeInTheDocument();
  });

  it("shows the loading skeleton while the traces query is loading", () => {
    useListTraces.mockReturnValue(
      tracesResult({ data: undefined, isLoading: true }),
    );

    const { container } = render(<Traces />);

    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByText("No traces yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No spans match your filters")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

const VIEW_STORAGE_KEY = "agent-observability:traces-view";

function group(over: Partial<TraceCostGroup> & { key: string }): TraceCostGroup {
  return { cost: 1, spanCount: 1, totalTokens: 10, costShare: 1, ...over };
}

// The most recent params object handed to the traces list query; this is what
// the page actually fetches with, so it proves the active group reaches the API.
function lastListParams(): Record<string, unknown> {
  const call = useListTraces.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

// The most recent params object handed to the breakdown query. In "navigate"
// mode this stays scoped to date/kind/search only; in "drillin" mode it also
// narrows to the active group.
function lastBreakdownParams(): Record<string, unknown> {
  const call = useGetTraceCostBreakdown.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

describe("Traces page breakdown click-to-filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useListTraces.mockReturnValue(tracesResult({}));
    useGetTraceSummary.mockReturnValue(summaryResult({}));
    useGetTraceCostBreakdown.mockReturnValue(
      breakdownResult({
        data: {
          noData: false,
          byModel: [group({ key: "gpt-4o" }), group({ key: "(no model)", cost: 0.5 })],
          byApp: [group({ key: "support-bot" })],
          byDepartment: [group({ key: "Engineering" })],
        },
      }),
    );
  });

  it("clicking a breakdown row sets the group filter, shows the chip and narrows the query", () => {
    render(<Traces />);

    // No active filter to begin with.
    expect(screen.queryByTestId("active-group-filter")).not.toBeInTheDocument();
    expect(lastListParams().model).toBeUndefined();

    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));

    // The chip appears and the row is marked active.
    const chip = screen.getByTestId("active-group-filter");
    expect(chip).toHaveTextContent("Model:");
    expect(chip).toHaveTextContent("gpt-4o");
    expect(screen.getByTestId("breakdown-row-gpt-4o")).toHaveAttribute("aria-pressed", "true");

    // The list query is re-issued scoped to the clicked model.
    expect(lastListParams().model).toBe("gpt-4o");
  });

  it("forwards the (no model) sentinel key unchanged to the query", () => {
    render(<Traces />);

    fireEvent.click(screen.getByTestId("breakdown-row-(no model)"));

    expect(lastListParams().model).toBe("(no model)");
    expect(screen.getByTestId("active-group-filter")).toHaveTextContent("(no model)");
  });

  it("clicking the active row again toggles the filter off", () => {
    render(<Traces />);

    const row = () => screen.getByTestId("breakdown-row-gpt-4o");
    fireEvent.click(row());
    expect(screen.getByTestId("active-group-filter")).toBeInTheDocument();

    fireEvent.click(row());
    expect(screen.queryByTestId("active-group-filter")).not.toBeInTheDocument();
    expect(row()).toHaveAttribute("aria-pressed", "false");
    expect(lastListParams().model).toBeUndefined();
  });

  it("the clear chip removes the active group filter", () => {
    render(<Traces />);

    fireEvent.click(screen.getByTestId("breakdown-row-support-bot"));
    expect(lastListParams().app).toBe("support-bot");

    fireEvent.click(screen.getByTestId("button-clear-group-filter"));

    expect(screen.queryByTestId("active-group-filter")).not.toBeInTheDocument();
    expect(lastListParams().app).toBeUndefined();
  });

  it("selecting a different dimension replaces the previous group filter", () => {
    render(<Traces />);

    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));
    expect(lastListParams().model).toBe("gpt-4o");

    fireEvent.click(screen.getByTestId("breakdown-row-Engineering"));
    const params = lastListParams();
    expect(params.department).toBe("Engineering");
    // Only one dimension is active at a time, so the model filter is dropped.
    expect(params.model).toBeUndefined();
  });

  it("persists the active group to the URL and localStorage", () => {
    render(<Traces />);

    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));

    // URL reflects the group via the group/gval params.
    const urls = navigate.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("group=model") && u.includes("gval=gpt-4o"))).toBe(true);

    // localStorage remembers the group so it survives <Link> navigation.
    const stored = JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) ?? "{}");
    expect(stored.group).toEqual({ dimension: "model", value: "gpt-4o" });
  });

  it("restores an active group filter from localStorage on mount", () => {
    window.localStorage.setItem(
      VIEW_STORAGE_KEY,
      JSON.stringify({ group: { dimension: "app", value: "support-bot" } }),
    );

    render(<Traces />);

    // The chip is shown and the query is scoped without any user interaction.
    expect(screen.getByTestId("active-group-filter")).toHaveTextContent("support-bot");
    expect(lastListParams().app).toBe("support-bot");
    expect(screen.getByTestId("breakdown-row-support-bot")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("falls back to the default view when localStorage.getItem throws", () => {
    // Safari private mode and locked-down enterprise profiles throw a
    // SecurityError on the getItem call itself, *before* any value is returned.
    // readStoredView() wraps the read in try/catch, so initialView() must fall
    // back to the defaults rather than crashing the page. This mirrors the
    // DateRangeProvider read-throw test for the traces-view storage key.
    // jsdom's localStorage delegates getItem to Storage.prototype, so the spy
    // must target the prototype (an instance spy is never hit).
    window.history.replaceState({}, "", "/traces");
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("storage is disabled", "SecurityError");
      });

    try {
      render(<Traces />);

      // Prove the read was actually attempted (and thus actually threw).
      expect(getItemSpy).toHaveBeenCalled();

      // The page mounts on its default view: no remembered group filter is
      // applied and the list query carries none of the group dimensions.
      expect(screen.queryByTestId("active-group-filter")).not.toBeInTheDocument();
      const params = lastListParams();
      expect(params.model).toBeUndefined();
      expect(params.app).toBeUndefined();
      expect(params.department).toBeUndefined();
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it("restores an active group filter from a cold shared URL (no localStorage)", () => {
    // Simulate opening a shared link in a fresh tab: the query string is present
    // at mount and there is no remembered view in localStorage.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?group=model&gval=gpt-4o");

    try {
      render(<Traces />);

      // The chip is shown and the query is scoped purely from the URL params.
      expect(screen.getByTestId("active-group-filter")).toHaveTextContent("Model:");
      expect(screen.getByTestId("active-group-filter")).toHaveTextContent("gpt-4o");
      expect(lastListParams().model).toBe("gpt-4o");
      expect(screen.getByTestId("breakdown-row-gpt-4o")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    } finally {
      // Reset the URL so it does not leak into other tests.
      window.history.replaceState({}, "", "/traces");
    }
  });
});

describe("Traces page breakdown Navigate vs Drill-in modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useListTraces.mockReturnValue(tracesResult({}));
    useGetTraceSummary.mockReturnValue(summaryResult({}));
    useGetTraceCostBreakdown.mockReturnValue(
      breakdownResult({
        data: {
          noData: false,
          byModel: [group({ key: "gpt-4o" })],
          byApp: [group({ key: "support-bot" })],
          byDepartment: [group({ key: "Engineering" })],
        },
      }),
    );
  });

  it("defaults to Navigate mode with Navigate pressed and Drill in not pressed", () => {
    render(<Traces />);

    expect(screen.getByTestId("breakdown-mode-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("breakdown-mode-navigate")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("keeps the breakdown query scoped to the base filters in Navigate mode", () => {
    render(<Traces />);

    // Selecting a row narrows the table/summary query but, in navigate mode,
    // the breakdown stays scoped to date/kind/search only (no active group).
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));

    expect(lastListParams().model).toBe("gpt-4o");
    expect(lastBreakdownParams().model).toBeUndefined();
  });

  it("narrows the breakdown query to the active group only in Drill-in mode", () => {
    render(<Traces />);

    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));
    // Sanity check: navigate mode does not pass the group to the breakdown.
    expect(lastBreakdownParams().model).toBeUndefined();

    fireEvent.click(screen.getByTestId("breakdown-mode-drillin"));

    // Now the breakdown query carries the active group too.
    expect(lastBreakdownParams().model).toBe("gpt-4o");
    // The table/summary query is unchanged — it always narrows to the group.
    expect(lastListParams().model).toBe("gpt-4o");
  });

  it("stops scoping the breakdown to the group when switching back to Navigate", () => {
    render(<Traces />);

    fireEvent.click(screen.getByTestId("breakdown-row-Engineering"));
    fireEvent.click(screen.getByTestId("breakdown-mode-drillin"));
    expect(lastBreakdownParams().department).toBe("Engineering");

    fireEvent.click(screen.getByTestId("breakdown-mode-navigate"));

    expect(lastBreakdownParams().department).toBeUndefined();
    // The group filter itself is still active for the table.
    expect(lastListParams().department).toBe("Engineering");
  });

  it("persists the mode to the URL (bmode) and localStorage", () => {
    render(<Traces />);

    fireEvent.click(screen.getByTestId("breakdown-mode-drillin"));

    // URL reflects the mode via the bmode param.
    const urls = navigate.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("bmode=drillin"))).toBe(true);

    // localStorage remembers the mode so it survives <Link> navigation.
    const stored = JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) ?? "{}");
    expect(stored.breakdownMode).toBe("drillin");
  });

  it("restores Drill-in mode from localStorage across a re-render", () => {
    window.localStorage.setItem(
      VIEW_STORAGE_KEY,
      JSON.stringify({
        breakdownMode: "drillin",
        group: { dimension: "model", value: "gpt-4o" },
      }),
    );

    const { unmount } = render(<Traces />);

    // Drill-in is active on mount and the breakdown is scoped to the group.
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(lastBreakdownParams().model).toBe("gpt-4o");

    // Re-rendering (e.g. navigating away and back) keeps the persisted mode.
    unmount();
    render(<Traces />);

    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(lastBreakdownParams().model).toBe("gpt-4o");
  });

  it("restores Drill-in mode from the bmode URL param on a cold load", () => {
    const original = window.location.search;
    Object.defineProperty(window, "location", {
      value: { ...window.location, search: "?bmode=drillin&group=app&gval=support-bot" },
      writable: true,
    });

    try {
      render(<Traces />);

      expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(lastBreakdownParams().app).toBe("support-bot");
    } finally {
      Object.defineProperty(window, "location", {
        value: { ...window.location, search: original },
        writable: true,
      });
    }
  });
});
