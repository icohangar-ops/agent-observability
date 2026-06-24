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
});
