import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  TraceList,
  TraceSummary,
  TraceCostBreakdown,
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

vi.mock("wouter", () => ({
  useLocation: () => ["/traces", vi.fn()],
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
