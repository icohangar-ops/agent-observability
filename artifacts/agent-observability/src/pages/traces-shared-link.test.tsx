import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLocation } from "wouter";
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
import { Toaster } from "@/components/ui/toaster";
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

// A minimal stand-in for the app's sidebar/menu links: it drives wouter's
// programmatic navigate to a fresh path with *no* query string — exactly what a
// <Link> does when the user moves to another page. The Traces page's URL-sync
// effect must re-apply the active breakdown filter onto that clean path, the
// same way the date-range effect re-applies the remembered range.
function NavControls() {
  const [, navigate] = useLocation();
  return (
    <>
      <button
        type="button"
        data-testid="nav-overview"
        onClick={() => navigate("/overview")}
      >
        Go to overview
      </button>
      <button
        type="button"
        data-testid="nav-traces"
        onClick={() => navigate("/traces")}
      >
        Back to traces
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

// The most recent params object handed to the breakdown query. In "navigate"
// mode this stays scoped to date/kind/search only; in "drillin" mode it also
// narrows to the active group — so the presence of a group dimension here is
// the observable proof that bmode=drillin actually reached the query.
function lastBreakdownParams(): Record<string, unknown> {
  const call = useGetTraceCostBreakdown.mock.calls.at(-1);
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

  it("restores the month preset and the breakdown filter from a cold shared URL without clobbering each other", async () => {
    // A fresh tab opening a shared link whose range is the *derived* "month"
    // preset (range=month, no concrete from/to in the URL) alongside the
    // breakdown params, with nothing in localStorage to fall back on. The month
    // preset takes a different parseSearch path than 7d — it re-derives from/to
    // from startOfMonth..today rather than reading them off the URL — so this
    // exercises that branch on the cold-load race specifically.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?range=month&group=model&gval=gpt-4o");

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

    // range=month re-derives a concrete startOfMonth..today window that reaches
    // the list query alongside the group filter.
    const today = new Date();
    const fromMonth = format(startOfMonth(today), "yyyy-MM-dd");
    const toMonth = format(today, "yyyy-MM-dd");
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(fromMonth);
      expect(params.to).toBe(toMonth);
    });

    // After both effects settle, the URL keeps range=month plus the breakdown's
    // group/gval. The month preset is derived, so its concrete from/to live in
    // the query, not the URL.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("month");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks must prove the URL has settled rather than ping-ponging.
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

  it("restores a custom from/to range and the breakdown filter from a cold shared URL without clobbering each other", async () => {
    // A fresh tab opening a shared link whose range is "custom" with concrete
    // from/to baked into the URL, alongside the breakdown params, with nothing
    // in localStorage to fall back on. The custom branch of parseSearch reads
    // the concrete from/to straight off the URL (unlike month, which derives
    // them), so this covers that path on the cold-load race specifically.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      `/traces?range=custom&from=${CUSTOM_FROM}&to=${CUSTOM_TO}&group=app&gval=support-bot`,
    );

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // The breakdown filter is active purely from the URL.
    const chip = await screen.findByTestId("active-group-filter");
    expect(chip).toHaveTextContent("App:");
    expect(chip).toHaveTextContent("support-bot");
    expect(screen.getByTestId("breakdown-row-support-bot")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The concrete custom from/to reach the list query alongside the group filter.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.app).toBe("support-bot");
      expect(params.from).toBe(CUSTOM_FROM);
      expect(params.to).toBe(CUSTOM_TO);
    });

    // After both effects settle, the URL keeps range=custom plus its concrete
    // from/to and the breakdown's group/gval — none clobbered.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("custom");
      expect(search.get("from")).toBe(CUSTOM_FROM);
      expect(search.get("to")).toBe(CUSTOM_TO);
      expect(search.get("group")).toBe("app");
      expect(search.get("gval")).toBe("support-bot");
    });

    // Extra ticks must prove the URL has settled rather than ping-ponging.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("custom");
    expect(settled.get("from")).toBe(CUSTOM_FROM);
    expect(settled.get("to")).toBe(CUSTOM_TO);
    expect(settled.get("group")).toBe("app");
    expect(settled.get("gval")).toBe("support-bot");
    const settledParams = lastListParams();
    expect(settledParams.app).toBe("support-bot");
    expect(settledParams.from).toBe(CUSTOM_FROM);
    expect(settledParams.to).toBe(CUSTOM_TO);
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

  it("re-applies the active breakdown filter to a clean path after page-to-page navigation", async () => {
    // Mid-session on an all-time page so the only live query param is the
    // breakdown filter — there is no date range to also re-apply, isolating the
    // breakdown's own location-change handling.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces");

    render(
      <DateRangeProvider>
        <NavControls />
        <Traces />
      </DateRangeProvider>,
    );

    // 1) Activate a breakdown filter by clicking a row.
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });
    // The filter reaches the list query on the original page.
    await waitFor(() => {
      expect(lastListParams().model).toBe("gpt-4o");
    });

    // 2) Move to another page via wouter navigation, which lands on a fresh path
    // carrying *no* query string (exactly what a <Link> does).
    fireEvent.click(screen.getByTestId("nav-overview"));

    // The destination path is reached and starts with no query of its own, then
    // the Traces URL-sync effect re-writes the breakdown filter back onto it.
    await waitFor(() => {
      expect(window.location.pathname).toBe("/overview");
      const search = new URLSearchParams(window.location.search);
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // The re-applied filter still reaches the data query after the move.
    await waitFor(() => {
      expect(lastListParams().model).toBe("gpt-4o");
    });

    // Extra ticks must prove the filter has truly settled on the new path rather
    // than being dropped a tick later (the regression #85 guards against).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe("/overview");
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
    expect(lastListParams().model).toBe("gpt-4o");
  });

  it("re-applies the breakdown view mode to a clean path after page-to-page navigation", async () => {
    // Mid-session on an all-time page so there is no date range or breakdown
    // group filter to also re-apply — the only non-default choice is the
    // breakdown view mode (bmode), isolating its slice of the *same* URL-sync
    // effect that #85/#87/#89 proved for the date range, group, kind, search,
    // and sort. A regression here would silently reset the user's breakdown
    // mode the moment they move to another page.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces");

    render(
      <DateRangeProvider>
        <NavControls />
        <Traces />
      </DateRangeProvider>,
    );

    // 1) Switch the breakdown mode to the non-default "drillin" via the real
    // toggle the page renders.
    fireEvent.click(screen.getByTestId("breakdown-mode-drillin"));

    // The mode lands in the live URL on the original page.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBe("drillin");
    });

    // 2) Move to another page via wouter navigation, which lands on a fresh path
    // carrying *no* query string (exactly what a <Link> does).
    fireEvent.click(screen.getByTestId("nav-overview"));

    // The destination path is reached and starts with no query of its own, then
    // the Traces URL-sync effect re-writes the breakdown mode back onto it.
    await waitFor(() => {
      expect(window.location.pathname).toBe("/overview");
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBe("drillin");
    });

    // Extra ticks must prove the mode has truly settled on the new path rather
    // than being dropped a tick later (the regression #85/#87/#89 guard against).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe("/overview");
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("bmode")).toBe("drillin");
  });

  it("keeps the breakdown view mode after navigating away and returning to traces", async () => {
    // The full round-trip a user makes: open on a cold shared link carrying
    // bmode=drillin, click away to another page (wouter drops the query string),
    // then come back to /traces on a *clean* path with no bmode in the URL. The
    // remembered breakdown mode must still be reflected in the toggle and the
    // URL-sync effect must re-write bmode=drillin back onto the clean /traces
    // path — mirroring the date range's "survives <Link> navigation" coverage.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?bmode=drillin");

    render(
      <DateRangeProvider>
        <NavControls />
        <Traces />
      </DateRangeProvider>,
    );

    // The drill-in toggle starts pressed purely from the URL's bmode param.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");

    // 1) Leave for another page; wouter lands on a fresh path with no query, then
    // the URL-sync effect re-writes bmode=drillin back onto it.
    fireEvent.click(screen.getByTestId("nav-overview"));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/overview");
      expect(new URLSearchParams(window.location.search).get("bmode")).toBe(
        "drillin",
      );
    });

    // 2) Return to /traces on a clean path (a <Link> drops the query string).
    fireEvent.click(screen.getByTestId("nav-traces"));

    // The toggle is still pressed and the URL-sync effect re-applies the
    // remembered bmode=drillin onto the clean /traces path.
    await waitFor(() => {
      expect(window.location.pathname).toBe("/traces");
      expect(new URLSearchParams(window.location.search).get("bmode")).toBe(
        "drillin",
      );
    });
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("breakdown-mode-navigate")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // Extra ticks must prove the mode has truly settled on /traces rather than
    // being dropped or ping-ponging back to the default a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe("/traces");
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("bmode")).toBe("drillin");
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps the restored drill-in mode narrowing the breakdown query after navigating away and back to traces", async () => {
    // The prior round-trip test proves bmode=drillin survives navigation in the
    // toggle and the URL; this one proves the *behavioral* consequence — that the
    // restored mode actually reaches the breakdown data query. Drill-in only
    // narrows the breakdown when a group is active, so the cold link carries both
    // bmode=drillin and an active group (group=model&gval=gpt-4o). The presence
    // of that group dimension in lastBreakdownParams() is the observable proof
    // that drillin reached useGetTraceCostBreakdown rather than just the UI; in
    // "navigate" mode the breakdown query would omit the group entirely.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?bmode=drillin&group=model&gval=gpt-4o",
    );

    render(
      <DateRangeProvider>
        <NavControls />
        <Traces />
      </DateRangeProvider>,
    );

    // The drill-in toggle starts pressed purely from the URL's bmode param.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");

    // On the original page, drill-in already narrows the breakdown query to the
    // active group.
    await waitFor(() => {
      expect(lastBreakdownParams().model).toBe("gpt-4o");
    });

    // 1) Leave for another page; wouter lands on a fresh path with no query, then
    // the URL-sync effect re-writes the breakdown filter and mode back onto it.
    fireEvent.click(screen.getByTestId("nav-overview"));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/overview");
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // 2) Return to /traces on a clean path (a <Link> drops the query string).
    fireEvent.click(screen.getByTestId("nav-traces"));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/traces");
      expect(new URLSearchParams(window.location.search).get("bmode")).toBe(
        "drillin",
      );
    });
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The behavioral proof: the restored drill-in mode still narrows the
    // breakdown query to the active group after the full round-trip, not just the
    // toggle and URL.
    await waitFor(() => {
      expect(lastBreakdownParams().model).toBe("gpt-4o");
    });

    // Extra ticks must prove the narrowed query has truly settled rather than
    // reverting to the un-narrowed "navigate"-mode query a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe("/traces");
    expect(lastBreakdownParams().model).toBe("gpt-4o");
  });

  it("keeps the default navigate mode showing every breakdown group even with an active group, while the list/summary still narrow", async () => {
    // The mirror image of the drill-in test above. A cold shared link carries an
    // active group (group=model&gval=gpt-4o) but leaves bmode at its default
    // ("navigate", which writes no bmode param). The default mode must keep the
    // breakdown query un-narrowed so every group card stays visible as a
    // navigation aid, while the list/summary queries still scope to the active
    // group. The *absence* of a model dimension in lastBreakdownParams() — paired
    // with its presence in lastListParams() — is the observable proof.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?group=model&gval=gpt-4o",
    );

    render(
      <DateRangeProvider>
        <NavControls />
        <Traces />
      </DateRangeProvider>,
    );

    // The group filter is active from the URL, and the default navigate mode is
    // pressed (no bmode param means navigate).
    const chip = await screen.findByTestId("active-group-filter");
    expect(chip).toHaveTextContent("Model:");
    expect(chip).toHaveTextContent("gpt-4o");
    expect(screen.getByTestId("breakdown-mode-navigate")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // The list/summary query narrows to the active group...
    await waitFor(() => {
      expect(lastListParams().model).toBe("gpt-4o");
    });
    // ...but the breakdown query stays un-narrowed so every group card shows.
    expect(lastBreakdownParams().model).toBeUndefined();

    // A full page round-trip must not flip the breakdown into a narrowed query:
    // leave for another page (the URL-sync effect re-applies group/gval but no
    // bmode), then return to /traces on a clean path.
    fireEvent.click(screen.getByTestId("nav-overview"));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/overview");
      const search = new URLSearchParams(window.location.search);
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
      expect(search.get("bmode")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("nav-traces"));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/traces");
      const search = new URLSearchParams(window.location.search);
      expect(search.get("group")).toBe("model");
      expect(search.get("bmode")).toBeNull();
    });
    expect(screen.getByTestId("breakdown-mode-navigate")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The behavioral proof after the round-trip: list still narrows, breakdown
    // still does not.
    await waitFor(() => {
      expect(lastListParams().model).toBe("gpt-4o");
    });
    expect(lastBreakdownParams().model).toBeUndefined();

    // Extra ticks prove the un-narrowed breakdown query has truly settled rather
    // than narrowing a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe("/traces");
    expect(lastBreakdownParams().model).toBeUndefined();
    expect(lastListParams().model).toBe("gpt-4o");
  });

  it("widens the breakdown query again so every card reappears when toggling drill-in back to navigate mid-session", async () => {
    // The cold-load tests above prove each mode's steady state in isolation; this
    // one proves the *transition*. A user lands in drill-in with an active group,
    // so the breakdown is narrowed to that group (only its row's sub-breakdown
    // shows). Toggling back to the default "navigate" mode must widen the
    // breakdown query again — dropping the group dimension so every card
    // reappears — while the list/summary stay scoped to the active group. A
    // regression here would strand the user on a narrowed breakdown after they
    // explicitly asked to "show all groups".
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?bmode=drillin&group=model&gval=gpt-4o",
    );

    render(
      <DateRangeProvider>
        <NavControls />
        <Traces />
      </DateRangeProvider>,
    );

    // Start pressed on drill-in purely from the URL's bmode param.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");

    // In drill-in the breakdown query is narrowed to the active group...
    await waitFor(() => {
      expect(lastBreakdownParams().model).toBe("gpt-4o");
    });
    // ...while the list query is also scoped to it.
    expect(lastListParams().model).toBe("gpt-4o");

    // Toggle back to the default "show all groups" mode mid-session.
    fireEvent.click(screen.getByTestId("breakdown-mode-navigate"));
    expect(screen.getByTestId("breakdown-mode-navigate")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // The behavioral proof: the breakdown query widens again (drops the group
    // dimension) so every card reappears, while the list stays narrowed.
    await waitFor(() => {
      expect(lastBreakdownParams().model).toBeUndefined();
    });
    expect(lastListParams().model).toBe("gpt-4o");

    // The default mode writes no bmode param, so switching back drops it from the
    // URL while the active group filter remains.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBeNull();
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks prove the widened breakdown has truly settled rather than
    // snapping back to a narrowed query a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastBreakdownParams().model).toBeUndefined();
    expect(lastListParams().model).toBe("gpt-4o");
    expect(
      new URLSearchParams(window.location.search).get("bmode"),
    ).toBeNull();
  });

  it("widens then re-narrows the breakdown query when clearing and re-selecting a group while staying in drill-in mode", async () => {
    // The toggle test above proves switching *modes* widens the breakdown. This
    // one keeps the mode fixed at drill-in and changes the *active group*: a
    // user lands in drill-in narrowed to gpt-4o, clears it by clicking the
    // active row again, then picks a different model. The breakdown query must
    // widen (groupParams empty) when no group is active and re-narrow to the new
    // group when one is picked — all without leaving drill-in. A regression
    // could strand the breakdown on the stale group or fail to widen on clear.
    useGetTraceCostBreakdown.mockReturnValue(
      breakdownResult({
        data: {
          noData: false,
          byModel: [group({ key: "gpt-4o" }), group({ key: "gpt-4o-mini" })],
          byApp: [group({ key: "support-bot" })],
          byDepartment: [group({ key: "Engineering" })],
        },
      }),
    );

    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?bmode=drillin&group=model&gval=gpt-4o",
    );

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // Start pressed on drill-in narrowed to gpt-4o, purely from the URL.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(lastBreakdownParams().model).toBe("gpt-4o");
    });

    // 1) Clear the active group by clicking its active row again. The breakdown
    // widens — the group dimension drops — while bmode stays drillin.
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o"));
    await waitFor(() => {
      expect(lastBreakdownParams().model).toBeUndefined();
    });
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The URL drops group/gval but keeps bmode=drillin throughout.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBeNull();
      expect(search.get("gval")).toBeNull();
    });

    // 2) Select a different group; the breakdown re-narrows to the new group
    // while bmode stays drillin.
    fireEvent.click(screen.getByTestId("breakdown-row-gpt-4o-mini"));
    await waitFor(() => {
      expect(lastBreakdownParams().model).toBe("gpt-4o-mini");
    });
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o-mini");
    });
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Extra ticks prove the re-narrowed breakdown settled rather than snapping
    // back to the stale group or widening again a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastBreakdownParams().model).toBe("gpt-4o-mini");
    expect(new URLSearchParams(window.location.search).get("bmode")).toBe(
      "drillin",
    );
  });

  it("keeps the drill-in breakdown narrowed to the active group while the date range changes across presets", async () => {
    // Tasks #98/#99 prove drill-in's narrowed breakdown survives the
    // drill-in<->navigate transition and a group clear/re-select. This one fixes
    // the *mode* and *group* and varies the third axis — the date range. A user
    // lands in drill-in narrowed to gpt-4o on a concrete 7d window, then walks
    // the date presets (7d -> 30d -> month -> all time). Through every switch the
    // breakdown query must stay narrowed to the active group (model=gpt-4o) AND
    // pick up the new from/to window, while the URL keeps bmode=drillin and the
    // group/gval. A regression could drop the group dimension when the window
    // changes, or fail to push the new from/to into the narrowed breakdown query.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?range=7d&bmode=drillin&group=model&gval=gpt-4o",
    );

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
    const fromMonth = format(startOfMonth(today), "yyyy-MM-dd");
    const toMonth = format(today, "yyyy-MM-dd");

    // Start pressed on drill-in purely from the URL's bmode param.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");

    // At mount the narrowed breakdown carries both the active group and the 7d
    // window — drill-in narrows the breakdown to the group, and the date range
    // scopes it to the 7d from/to.
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(from7d);
      expect(params.to).toBe(to7d);
    });

    // 1) Switch to the 30d preset. The breakdown keeps the group dimension but
    // updates from/to to the 30d window.
    fireEvent.click(screen.getByTestId("apply-30d"));
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(from30d);
      expect(params.to).toBe(to30d);
    });
    // The URL keeps bmode=drillin and the group/gval while recording the 30d range.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("30d");
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // 2) Switch to the "This month" preset. The breakdown keeps the group and
    // updates from/to to the month window.
    fireEvent.click(screen.getByTestId("apply-month"));
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(fromMonth);
      expect(params.to).toBe(toMonth);
    });
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("month");
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // 3) Switch to "All time". The breakdown drops from/to entirely but still
    // keeps the group dimension narrowed.
    fireEvent.click(screen.getByTestId("apply-all"));
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBeUndefined();
      expect(params.to).toBeUndefined();
    });
    // The URL strips range/from/to while keeping bmode=drillin and the group.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBeNull();
      expect(search.get("from")).toBeNull();
      expect(search.get("to")).toBeNull();
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks prove the narrowed-yet-all-time breakdown settled rather than
    // dropping the group or snapping a date window back a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settledParams = lastBreakdownParams();
    expect(settledParams.model).toBe("gpt-4o");
    expect(settledParams.from).toBeUndefined();
    expect(settledParams.to).toBeUndefined();
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("bmode")).toBe("drillin");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
  });

  it("keeps the drill-in breakdown narrowed to the active group while the kind and search filters change", async () => {
    // Tasks #98/#99/#100 prove drill-in's narrowed breakdown survives the
    // drill-in<->navigate transition, a group clear/re-select, and a changing
    // date range. This one fixes the *mode* and *group* and varies the last
    // untested axis — the kind dropdown and the search box. A user lands in
    // drill-in narrowed to gpt-4o, picks a span kind via the real kind control,
    // then types a search term. Through both changes the breakdown query must
    // stay narrowed to the active group (model=gpt-4o) AND pick up the new
    // kind/q, while the URL keeps bmode=drillin and the group/gval. A regression
    // could drop the group dimension when kind/q change, or fail to push the new
    // kind/q into the narrowed breakdown query.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?bmode=drillin&group=model&gval=gpt-4o",
    );

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // Start pressed on drill-in purely from the URL's bmode param.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");

    // At mount the narrowed breakdown carries the active group and no kind/q yet.
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.kind).toBeUndefined();
      expect(params.q).toBeUndefined();
    });

    // 1) Change the span kind via the real kind control: open the Radix select
    // and click the "LLM" option, exactly as a user would.
    fireEvent.click(screen.getByTestId("select-kind"));
    fireEvent.click(await screen.findByText("LLM"));

    // The breakdown keeps the group dimension but now also carries kind=llm.
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.kind).toBe("llm");
    });
    // The URL keeps bmode=drillin and the group/gval while recording kind=llm.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("kind")).toBe("llm");
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // 2) Type a search term via the real search box.
    fireEvent.change(screen.getByTestId("input-search-traces"), {
      target: { value: "gpt" },
    });

    // The breakdown still keeps the group dimension and the kind, and now also
    // carries q=gpt — none of the three drop out.
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.kind).toBe("llm");
      expect(params.q).toBe("gpt");
    });
    // The URL keeps bmode=drillin and the group/gval while recording kind/q.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("kind")).toBe("llm");
      expect(search.get("q")).toBe("gpt");
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks prove the narrowed-yet-filtered breakdown settled rather than
    // dropping the group or a filter a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settledParams = lastBreakdownParams();
    expect(settledParams.model).toBe("gpt-4o");
    expect(settledParams.kind).toBe("llm");
    expect(settledParams.q).toBe("gpt");
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("bmode")).toBe("drillin");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
    expect(settled.get("kind")).toBe("llm");
    expect(settled.get("q")).toBe("gpt");
  });

  it("keeps the drill-in breakdown narrowed to the active group when the kind filter is cleared back to All kinds", async () => {
    // The prior test proves drill-in's narrowed breakdown survives *adding* a
    // kind. This one fixes the *mode* and *group* and exercises the opposite
    // direction on the kind axis: a user lands in drill-in narrowed to gpt-4o
    // with an active kind=llm, then resets the kind back to "All kinds" via the
    // real kind control. Clearing the kind must drop it from the narrowed
    // breakdown query and the URL while keeping the group dimension narrowed
    // (model=gpt-4o) and bmode=drillin. A regression could leave a stale kind in
    // the narrowed breakdown query, or drop the group when the kind clears.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?bmode=drillin&group=model&gval=gpt-4o&kind=llm",
    );

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // Start pressed on drill-in purely from the URL's bmode param.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");

    // At mount the narrowed breakdown carries both the active group and kind=llm,
    // all purely from the URL.
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.kind).toBe("llm");
    });

    // Reset the span kind via the real kind control: open the Radix select and
    // click the "All kinds" option, exactly as a user would.
    fireEvent.click(screen.getByTestId("select-kind"));
    fireEvent.click(await screen.findByText("All kinds"));

    // The breakdown keeps the group dimension but kind drops out entirely.
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.kind).toBeUndefined();
    });
    // The URL drops kind while keeping bmode=drillin and the group/gval.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("kind")).toBeNull();
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks prove the narrowed breakdown settled rather than dropping the
    // group or re-introducing a stale kind a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settledParams = lastBreakdownParams();
    expect(settledParams.model).toBe("gpt-4o");
    expect(settledParams.kind).toBeUndefined();
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("kind")).toBeNull();
    expect(settled.get("bmode")).toBe("drillin");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
  });

  it("keeps the drill-in breakdown narrowed to the active group when the search term is cleared", async () => {
    // The kind axis already has both directions covered (#101 adds a kind, #102
    // clears it back to "All kinds"). This is the matching reverse case for the
    // *search* axis: a user lands in drill-in narrowed to gpt-4o with a non-empty
    // search (q=gpt), then clears the search box. Clearing the search must drop q
    // from the narrowed breakdown query and the URL while keeping the group
    // dimension narrowed (model=gpt-4o) and bmode=drillin. A regression could
    // leave a stale q in the narrowed breakdown query, or drop the group when the
    // search clears.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?bmode=drillin&group=model&gval=gpt-4o&q=gpt",
    );

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // Start pressed on drill-in purely from the URL's bmode param.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");

    // At mount the narrowed breakdown carries both the active group and q=gpt,
    // all purely from the URL.
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.q).toBe("gpt");
    });

    // Clear the search via the real search box, exactly as a user would by
    // selecting the text and deleting it.
    fireEvent.change(screen.getByTestId("input-search-traces"), {
      target: { value: "" },
    });

    // The breakdown keeps the group dimension but q drops out entirely.
    await waitFor(() => {
      const params = lastBreakdownParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.q).toBeUndefined();
    });
    // The URL drops q while keeping bmode=drillin and the group/gval.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("q")).toBeNull();
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks prove the narrowed breakdown settled rather than dropping the
    // group or re-introducing a stale q a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settledParams = lastBreakdownParams();
    expect(settledParams.model).toBe("gpt-4o");
    expect(settledParams.q).toBeUndefined();
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("q")).toBeNull();
    expect(settled.get("bmode")).toBe("drillin");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
  });

  it("clears kind, search, sort, and the breakdown filter together when the Reset View control is used", async () => {
    // Tasks #101/#102/#103 each clear a *single* control (kind back to All
    // kinds, the search box). This covers the page's one-click Reset View path
    // (resetView), which must clear kind, search, sort, AND the active
    // cost-breakdown filter (group/gval + bmode) *together*. A user lands with
    // all of them active via a shared URL — a span kind (kind=llm), a search
    // term (q=gpt), a sort (sort=cost&dir=asc), a breakdown group
    // (group=model&gval=gpt-4o), and drill-in mode (bmode=drillin) — then hits
    // Reset. The reset must drop kind/q/group from the list and breakdown
    // queries, drop kind/q/sort/dir/group/gval/bmode from the URL, and wipe the
    // stale view out of localStorage. A regression that leaves any one filter
    // behind (a stale kind, q, sort, group, or bmode) would be caught here.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?kind=llm&q=gpt&sort=cost&dir=asc&group=model&gval=gpt-4o&bmode=drillin",
    );

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // At mount all controls are active purely from the URL: kind+q+group reach
    // both the list and breakdown queries (the group reaches the breakdown query
    // because bmode=drillin narrows it to the active group)...
    await waitFor(() => {
      const list = lastListParams();
      expect(list.kind).toBe("llm");
      expect(list.q).toBe("gpt");
      expect(list.model).toBe("gpt-4o");
    });
    await waitFor(() => {
      const bd = lastBreakdownParams();
      expect(bd.kind).toBe("llm");
      expect(bd.q).toBe("gpt");
      expect(bd.model).toBe("gpt-4o");
    });
    // ...and kind/q/sort/dir/group/gval/bmode are all live in the URL together.
    const initialSearch = new URLSearchParams(window.location.search);
    expect(initialSearch.get("kind")).toBe("llm");
    expect(initialSearch.get("q")).toBe("gpt");
    expect(initialSearch.get("sort")).toBe("cost");
    expect(initialSearch.get("dir")).toBe("asc");
    expect(initialSearch.get("group")).toBe("model");
    expect(initialSearch.get("gval")).toBe("gpt-4o");
    expect(initialSearch.get("bmode")).toBe("drillin");
    // The breakdown filter chip confirms the group filter is active.
    expect(screen.getByTestId("active-group-filter")).toHaveTextContent("gpt-4o");

    // Trigger the page's real one-click Reset View control. With several filters
    // active it asks for confirmation first (task #106), so confirm the wipe.
    fireEvent.click(screen.getByTestId("button-reset-view"));
    fireEvent.click(screen.getByTestId("button-confirm-reset"));

    // The list and breakdown queries drop kind, q, and the group together. (Sort
    // is applied client-side, so it never appears in the query params.)
    await waitFor(() => {
      const list = lastListParams();
      expect(list.kind).toBeUndefined();
      expect(list.q).toBeUndefined();
      expect(list.model).toBeUndefined();
    });
    await waitFor(() => {
      const bd = lastBreakdownParams();
      expect(bd.kind).toBeUndefined();
      expect(bd.q).toBeUndefined();
      expect(bd.model).toBeUndefined();
    });

    // The URL drops kind, q, sort, dir, group, gval, and bmode together.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("kind")).toBeNull();
      expect(search.get("q")).toBeNull();
      expect(search.get("sort")).toBeNull();
      expect(search.get("dir")).toBeNull();
      expect(search.get("group")).toBeNull();
      expect(search.get("gval")).toBeNull();
      expect(search.get("bmode")).toBeNull();
    });

    // The breakdown filter chip is gone once the group filter is cleared.
    expect(screen.queryByTestId("active-group-filter")).toBeNull();

    // The reset wipes the stale view from localStorage. The persist effect
    // re-runs after reset and re-writes the *default* view, so the key may exist
    // again — but it must no longer carry any of the cleared kind/q/sort/group/
    // bmode.
    await waitFor(() => {
      const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
      const stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      expect(stored.kind ?? "__all__").toBe("__all__");
      expect(stored.search ?? "").toBe("");
      expect(stored.sortColumn ?? null).toBeNull();
      expect(stored.group ?? null).toBeNull();
      expect(stored.breakdownMode ?? "navigate").toBe("navigate");
    });

    // The Reset control disappears once there is nothing left to reset.
    await waitFor(() => {
      expect(screen.queryByTestId("button-reset-view")).toBeNull();
    });

    // Extra ticks prove the cleared state settled rather than a stale
    // kind/q/sort/group/bmode creeping back a tick later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("kind")).toBeNull();
    expect(settled.get("q")).toBeNull();
    expect(settled.get("sort")).toBeNull();
    expect(settled.get("dir")).toBeNull();
    expect(settled.get("group")).toBeNull();
    expect(settled.get("gval")).toBeNull();
    expect(settled.get("bmode")).toBeNull();
    const settledList = lastListParams();
    expect(settledList.kind).toBeUndefined();
    expect(settledList.q).toBeUndefined();
    expect(settledList.model).toBeUndefined();
    const settledBd = lastBreakdownParams();
    expect(settledBd.kind).toBeUndefined();
    expect(settledBd.q).toBeUndefined();
    expect(settledBd.model).toBeUndefined();
  });

  it("offers an Undo toast after a reset that restores the exact prior view and its localStorage", async () => {
    // After Reset wipes a carefully assembled view (task #107), a short-lived
    // toast must offer an "Undo" that restores the *exact* prior view — span
    // kind, search, sort + direction, the breakdown group, and the drill-in
    // mode — and re-writes it to localStorage so it survives later navigation.
    // A user lands via a shared URL carrying all of those, hits Reset, then
    // Undo; every cleared filter must come back together.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?kind=llm&q=gpt&sort=cost&dir=asc&group=model&gval=gpt-4o&bmode=drillin",
    );

    render(
      <DateRangeProvider>
        <Traces />
        <Toaster />
      </DateRangeProvider>,
    );

    // All controls start active purely from the URL: kind+q+group reach the list
    // query (the group reaches it because bmode=drillin narrows to that group).
    await waitFor(() => {
      const list = lastListParams();
      expect(list.kind).toBe("llm");
      expect(list.q).toBe("gpt");
      expect(list.model).toBe("gpt-4o");
    });
    expect(screen.getByTestId("active-group-filter")).toHaveTextContent("gpt-4o");

    // Reset asks to confirm with several filters active (task #106); confirm it.
    fireEvent.click(screen.getByTestId("button-reset-view"));
    fireEvent.click(screen.getByTestId("button-confirm-reset"));

    // The view is cleared: the list query drops kind/q/group and the URL drops
    // every view param.
    await waitFor(() => {
      const list = lastListParams();
      expect(list.kind).toBeUndefined();
      expect(list.q).toBeUndefined();
      expect(list.model).toBeUndefined();
    });
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("kind")).toBeNull();
      expect(search.get("q")).toBeNull();
      expect(search.get("group")).toBeNull();
    });
    expect(screen.queryByTestId("active-group-filter")).toBeNull();

    // The Undo toast appears with its action button.
    const undo = await screen.findByTestId("button-undo-reset");
    expect(undo).toHaveTextContent("Undo");

    // Click Undo — every cleared filter comes back to the list query together.
    fireEvent.click(undo);

    await waitFor(() => {
      const list = lastListParams();
      expect(list.kind).toBe("llm");
      expect(list.q).toBe("gpt");
      expect(list.model).toBe("gpt-4o");
    });

    // The URL is rebuilt with the exact prior view, sort direction included.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("kind")).toBe("llm");
      expect(search.get("q")).toBe("gpt");
      expect(search.get("sort")).toBe("cost");
      expect(search.get("dir")).toBe("asc");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
      expect(search.get("bmode")).toBe("drillin");
    });

    // The breakdown filter chip is back, proving the group filter is restored.
    expect(screen.getByTestId("active-group-filter")).toHaveTextContent("gpt-4o");

    // The restored view is written back to localStorage so it survives a later
    // <Link> navigation that drops the query string.
    await waitFor(() => {
      const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const stored = JSON.parse(raw ?? "{}") as Record<string, unknown>;
      expect(stored.kind).toBe("llm");
      expect(stored.search).toBe("gpt");
      expect(stored.sortColumn).toBe("cost");
      expect(stored.sortDirection).toBe("asc");
      expect(stored.group).toEqual({ dimension: "model", value: "gpt-4o" });
      expect(stored.breakdownMode).toBe("drillin");
    });
  });

  it("re-applies the kind, search, and sort choices to a clean path after page-to-page navigation", async () => {
    // Mid-session on an all-time page so there is no date range to also
    // re-apply, isolating the kind/search/sort slice of the *same* URL-sync
    // effect that #85/#87 proved for the date range and breakdown filter. The
    // kind starts in the URL (as a shared link would carry it) while the search
    // and sort are driven through the page's real controls.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?kind=llm");

    // The sort controls only render once the table has at least one span, so
    // seed a single row for this test.
    useListTraces.mockReturnValue(
      tracesResult({
        data: {
          noData: false,
          spans: [
            {
              spanId: "span-1",
              traceId: "trace-1",
              parentId: null,
              name: "chat.completion",
              kind: "llm",
              model: "gpt-4o",
              provider: "openai",
              inputTokens: 10,
              outputTokens: 20,
              totalTokens: 30,
              estimatedCostUsd: 0.01,
              latencyMs: 120,
              status: "ok",
              timestamp: "2026-06-01T00:00:00.000Z",
              mlApp: "support-bot",
              tags: [],
            },
          ],
        },
      }),
    );

    render(
      <DateRangeProvider>
        <NavControls />
        <Traces />
      </DateRangeProvider>,
    );

    // 1) Type a search term and pick a sort column via the real controls.
    fireEvent.change(screen.getByTestId("input-search-traces"), {
      target: { value: "gpt" },
    });
    fireEvent.click(screen.getByTestId("sort-cost"));

    // All three choices land in the live URL on the original page.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("kind")).toBe("llm");
      expect(search.get("q")).toBe("gpt");
      expect(search.get("sort")).toBe("cost");
      expect(search.get("dir")).toBe("desc");
    });
    // And they reach the list query on the original page.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.kind).toBe("llm");
      expect(params.q).toBe("gpt");
    });

    // 2) Move to another page via wouter navigation, which lands on a fresh path
    // carrying *no* query string (exactly what a <Link> does).
    fireEvent.click(screen.getByTestId("nav-overview"));

    // The destination path is reached and the Traces URL-sync effect re-writes
    // the kind, search, and sort back onto it.
    await waitFor(() => {
      expect(window.location.pathname).toBe("/overview");
      const search = new URLSearchParams(window.location.search);
      expect(search.get("kind")).toBe("llm");
      expect(search.get("q")).toBe("gpt");
      expect(search.get("sort")).toBe("cost");
      expect(search.get("dir")).toBe("desc");
    });

    // The re-applied kind and search still reach the data query after the move.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.kind).toBe("llm");
      expect(params.q).toBe("gpt");
    });

    // Extra ticks must prove the choices have truly settled on the new path
    // rather than being dropped a tick later (the regression #85 guards against).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe("/overview");
    const settledView = new URLSearchParams(window.location.search);
    expect(settledView.get("kind")).toBe("llm");
    expect(settledView.get("q")).toBe("gpt");
    expect(settledView.get("sort")).toBe("cost");
    expect(settledView.get("dir")).toBe("desc");
    const settledViewParams = lastListParams();
    expect(settledViewParams.kind).toBe("llm");
    expect(settledViewParams.q).toBe("gpt");
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

  it("lets a shared link's range win over a previously remembered range in storage", async () => {
    // A returning user: localStorage already remembers a 30d range from a prior
    // visit, then they open a friend's shared link carrying a *different* range
    // (7d) plus a breakdown filter. initialState() prefers parseSearch over
    // parseStorage, so the URL's 7d must win the cold-load race — the stale
    // stored 30d must not override it.
    const today = new Date();
    const from30d = format(subDays(today, 29), "yyyy-MM-dd");
    const to30d = format(today, "yyyy-MM-dd");
    window.localStorage.setItem(
      DATE_STORAGE_KEY,
      JSON.stringify({ preset: "30d", from: from30d, to: to30d }),
    );
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

    // The URL's 7d window — not the remembered 30d — reaches the list query.
    const expectedFrom = format(subDays(today, 6), "yyyy-MM-dd");
    const expectedTo = format(today, "yyyy-MM-dd");
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(expectedFrom);
      expect(params.to).toBe(expectedTo);
      // The stale 30d window must not have leaked through.
      expect(params.from).not.toBe(from30d);
    });

    // The URL keeps the shared link's range/group/gval intact.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("7d");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Storage is rewritten to match the shared link (7d), not the other way around.
    await waitFor(() => {
      const dateStored = JSON.parse(
        window.localStorage.getItem(DATE_STORAGE_KEY) ?? "{}",
      );
      expect(dateStored.preset).toBe("7d");
    });

    // Extra ticks must prove nothing reverts to the remembered 30d range.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("7d");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
    const settledParams = lastListParams();
    expect(settledParams.from).toBe(expectedFrom);
    expect(settledParams.to).toBe(expectedTo);
    expect(
      JSON.parse(window.localStorage.getItem(DATE_STORAGE_KEY) ?? "{}").preset,
    ).toBe("7d");
  });

  it("lets a shared month-preset link win over a remembered custom range in storage", async () => {
    // A returning user whose remembered range is a concrete custom from/to from
    // a prior visit, who then opens a shared link carrying the derived "month"
    // preset. The URL must still win: month re-derives startOfMonth..today and
    // the stale custom window must not survive.
    window.localStorage.setItem(
      DATE_STORAGE_KEY,
      JSON.stringify({ preset: "custom", from: CUSTOM_FROM, to: CUSTOM_TO }),
    );
    window.history.replaceState({}, "", "/traces?range=month&group=model&gval=gpt-4o");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    const chip = await screen.findByTestId("active-group-filter");
    expect(chip).toHaveTextContent("Model:");
    expect(chip).toHaveTextContent("gpt-4o");

    // range=month re-derives a concrete startOfMonth..today window that reaches
    // the list query — the remembered custom window must not leak through.
    const today = new Date();
    const fromMonth = format(startOfMonth(today), "yyyy-MM-dd");
    const toMonth = format(today, "yyyy-MM-dd");
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(fromMonth);
      expect(params.to).toBe(toMonth);
      expect(params.from).not.toBe(CUSTOM_FROM);
      expect(params.to).not.toBe(CUSTOM_TO);
    });

    // The URL keeps range=month plus the breakdown's group/gval.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("month");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Storage is rewritten to the month preset, not left as the stale custom range.
    await waitFor(() => {
      const dateStored = JSON.parse(
        window.localStorage.getItem(DATE_STORAGE_KEY) ?? "{}",
      );
      expect(dateStored.preset).toBe("month");
    });

    // Extra ticks must prove nothing reverts to the remembered custom range.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("month");
    expect(settled.get("from")).toBeNull();
    expect(settled.get("to")).toBeNull();
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
    const settledParams = lastListParams();
    expect(settledParams.from).toBe(fromMonth);
    expect(settledParams.to).toBe(toMonth);
    expect(
      JSON.parse(window.localStorage.getItem(DATE_STORAGE_KEY) ?? "{}").preset,
    ).toBe("month");
  });

  it("restores a remembered preset range from storage on a fresh visit with no link", async () => {
    // A returning visitor with no shared link: the URL carries no range params,
    // but localStorage remembers a 30d preset from a prior visit. initialState()
    // finds nothing in parseSearch and falls back to parseStorage, which
    // re-derives the concrete 30d window from the stored preset.
    const today = new Date();
    const from30d = format(subDays(today, 29), "yyyy-MM-dd");
    const to30d = format(today, "yyyy-MM-dd");
    window.localStorage.setItem(
      DATE_STORAGE_KEY,
      JSON.stringify({ preset: "30d", from: from30d, to: to30d }),
    );
    // No range query params at all — a pure storage-only restore.
    window.history.replaceState({}, "", "/traces");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // The remembered 30d window reaches the list query even without a link.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.from).toBe(from30d);
      expect(params.to).toBe(to30d);
    });

    // The provider rewrites the URL to reflect the restored range so it is
    // shareable again. The 30d preset is derived, so only range lands in the URL.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("30d");
      expect(search.get("from")).toBeNull();
      expect(search.get("to")).toBeNull();
    });

    // Extra ticks must prove the restored range has settled (no ping-pong).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("30d");
    const settledParams = lastListParams();
    expect(settledParams.from).toBe(from30d);
    expect(settledParams.to).toBe(to30d);
  });

  it("restores a remembered custom from/to range from storage on a fresh visit with no link", async () => {
    // A returning visitor whose remembered range is a concrete custom window,
    // opening the page with no range params in the URL. parseStorage reads the
    // stored from/to straight back (unlike a preset, which is re-derived).
    window.localStorage.setItem(
      DATE_STORAGE_KEY,
      JSON.stringify({ preset: "custom", from: CUSTOM_FROM, to: CUSTOM_TO }),
    );
    window.history.replaceState({}, "", "/traces");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // The remembered custom window reaches the list query without a link.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.from).toBe(CUSTOM_FROM);
      expect(params.to).toBe(CUSTOM_TO);
    });

    // The URL is rewritten to range=custom plus its concrete from/to.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("range")).toBe("custom");
      expect(search.get("from")).toBe(CUSTOM_FROM);
      expect(search.get("to")).toBe(CUSTOM_TO);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBe("custom");
    expect(settled.get("from")).toBe(CUSTOM_FROM);
    expect(settled.get("to")).toBe(CUSTOM_TO);
    const settledParams = lastListParams();
    expect(settledParams.from).toBe(CUSTOM_FROM);
    expect(settledParams.to).toBe(CUSTOM_TO);
  });

  it("ignores malformed JSON in storage and defaults to all time", async () => {
    // Corrupted storage (not valid JSON) must not crash the provider: the
    // try/catch in parseStorage swallows the parse error and initialState()
    // falls back to the all-time default.
    window.localStorage.setItem(DATE_STORAGE_KEY, "not-valid-json {{{");
    window.history.replaceState({}, "", "/traces");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // All-time means no date window is sent to the API.
    await waitFor(() => {
      const params = lastListParams();
      expect(params.from).toBeUndefined();
      expect(params.to).toBeUndefined();
    });

    // No range/from/to are injected into the URL for the all-time default.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBeNull();
    expect(settled.get("from")).toBeNull();
    expect(settled.get("to")).toBeNull();
    const settledParams = lastListParams();
    expect(settledParams.from).toBeUndefined();
    expect(settledParams.to).toBeUndefined();
  });

  it("ignores an unknown preset in storage and defaults to all time", async () => {
    // Well-formed JSON but a preset the app no longer recognizes (e.g. a value
    // from an older build). isPreset() rejects it, the custom branch needs a
    // from/to it lacks, so parseStorage returns null and the provider defaults
    // to all time rather than honoring the stale preset.
    window.localStorage.setItem(
      DATE_STORAGE_KEY,
      JSON.stringify({ preset: "quarter" }),
    );
    window.history.replaceState({}, "", "/traces");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    await waitFor(() => {
      const params = lastListParams();
      expect(params.from).toBeUndefined();
      expect(params.to).toBeUndefined();
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("range")).toBeNull();
    expect(settled.get("from")).toBeNull();
    expect(settled.get("to")).toBeNull();
    const settledParams = lastListParams();
    expect(settledParams.from).toBeUndefined();
    expect(settledParams.to).toBeUndefined();
  });

  it("falls back to all time when localStorage.getItem throws", async () => {
    // Safari private mode and locked-down enterprise profiles throw a
    // SecurityError on the getItem call itself, *before* any value is returned —
    // a distinct failure mode from the malformed-JSON / unknown-preset cases
    // above, which fail inside JSON.parse / validation after getItem returns.
    // The try/catch in parseStorage must swallow this read throw too, so
    // initialState() falls back to the all-time default rather than crashing.
    // jsdom's localStorage delegates getItem to Storage.prototype, so the spy
    // must target the prototype (an instance spy is never hit).
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("storage is disabled", "SecurityError");
      });

    try {
      window.history.replaceState({}, "", "/traces");

      render(
        <DateRangeProvider>
          <Traces />
        </DateRangeProvider>,
      );

      // All-time means no date window is sent to the API, even though the read
      // threw at mount.
      await waitFor(() => {
        const params = lastListParams();
        expect(params.from).toBeUndefined();
        expect(params.to).toBeUndefined();
      });

      // Prove the read was actually attempted (and thus actually threw).
      expect(getItemSpy).toHaveBeenCalled();

      // No range/from/to are injected into the URL for the all-time default,
      // and the URL must stay settled rather than ping-ponging.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = new URLSearchParams(window.location.search);
      expect(settled.get("range")).toBeNull();
      expect(settled.get("from")).toBeNull();
      expect(settled.get("to")).toBeNull();
      const settledParams = lastListParams();
      expect(settledParams.from).toBeUndefined();
      expect(settledParams.to).toBeUndefined();
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it("still applies the date range when localStorage.setItem throws", async () => {
    // Private-mode / quota-exceeded / storage-disabled browsers throw on every
    // setItem. The provider's persist effect wraps the write in try/catch, so a
    // throw here must not crash the app: the chosen range must still reach the
    // list query and the shared URL for the current session. This is the
    // write-failure twin of the malformed-JSON read-failure case above.
    // jsdom's localStorage delegates setItem to Storage.prototype, so the spy
    // must target the prototype (an instance spy is never hit).
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("storage is disabled", "SecurityError");
      });

    try {
      window.history.replaceState({}, "", "/traces");

      render(
        <DateRangeProvider>
          <PresetControls />
          <Traces />
        </DateRangeProvider>,
      );

      // Mount must not crash even though the initial persist write throws.
      expect(screen.getByTestId("apply-7d")).toBeInTheDocument();

      // Apply a 7d range exactly as the date picker would. The persist write
      // throws again, but the range must still take effect for this session.
      fireEvent.click(screen.getByTestId("apply-7d"));

      const today = new Date();
      const expectedFrom = format(subDays(today, 6), "yyyy-MM-dd");
      const expectedTo = format(today, "yyyy-MM-dd");

      // The 7d window reaches the list query despite the storage write failing.
      await waitFor(() => {
        const params = lastListParams();
        expect(params.from).toBe(expectedFrom);
        expect(params.to).toBe(expectedTo);
      });

      // And it reaches the shared URL so the filter is still shareable.
      await waitFor(() => {
        const search = new URLSearchParams(window.location.search);
        expect(search.get("range")).toBe("7d");
      });

      // Prove the write was actually attempted (and thus actually threw).
      expect(setItemSpy).toHaveBeenCalled();

      // Extra ticks must keep the range live rather than ping-ponging away.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = new URLSearchParams(window.location.search);
      expect(settled.get("range")).toBe("7d");
      const settledParams = lastListParams();
      expect(settledParams.from).toBe(expectedFrom);
      expect(settledParams.to).toBe(expectedTo);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it("restores the drill-in breakdown mode from a cold shared URL with nothing in storage", async () => {
    // A fresh tab opening a shared link whose only non-default param is the
    // breakdown view mode (bmode=drillin), with nothing remembered in
    // localStorage to fall back on. initialView() must read bmode straight off
    // the URL so the "Drill in" toggle starts active, and the URL-sync effect
    // must keep bmode=drillin rather than stripping it back to the default.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?bmode=drillin");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // The "Drill in" toggle is active purely from the URL.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");
    // ...and "Navigate" is correspondingly inactive.
    expect(screen.getByTestId("breakdown-mode-navigate")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // The URL keeps bmode=drillin after the sync effect runs.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBe("drillin");
    });

    // Extra ticks must prove the URL has settled rather than ping-ponging the
    // mode away (e.g. back to the default "navigate", which writes no bmode).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("bmode")).toBe("drillin");
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("restores bmode, range, and the breakdown filter together from a cold shared URL without clobbering each other", async () => {
    // A fresh tab opening a fully-loaded shared link: the breakdown view mode
    // (bmode=drillin), the date range (range=7d), and the active group filter
    // (group=model&gval=gpt-4o) are all present at mount, with nothing in
    // localStorage. None of the three URL-sync paths (Traces' view effect and
    // the provider's range effect over the same query string) may clobber the
    // others, and bmode=drillin must actually reach the breakdown query.
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/traces?bmode=drillin&range=7d&group=model&gval=gpt-4o",
    );

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // The "Drill in" toggle and the group filter are both active from the URL.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");
    const chip = screen.getByTestId("active-group-filter");
    expect(chip).toHaveTextContent("Model:");
    expect(chip).toHaveTextContent("gpt-4o");
    expect(screen.getByTestId("breakdown-row-gpt-4o")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The 7d window and the group filter reach the list query together.
    const today = new Date();
    const expectedFrom = format(subDays(today, 6), "yyyy-MM-dd");
    const expectedTo = format(today, "yyyy-MM-dd");
    await waitFor(() => {
      const params = lastListParams();
      expect(params.model).toBe("gpt-4o");
      expect(params.from).toBe(expectedFrom);
      expect(params.to).toBe(expectedTo);
    });

    // Drill-in mode narrows the breakdown query to the active group too — proof
    // that bmode=drillin reached the query, not just the toggle's appearance.
    await waitFor(() => {
      const bparams = lastBreakdownParams();
      expect(bparams.model).toBe("gpt-4o");
      expect(bparams.from).toBe(expectedFrom);
      expect(bparams.to).toBe(expectedTo);
    });

    // After all effects settle, the URL keeps bmode, range, and group/gval.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBe("drillin");
      expect(search.get("range")).toBe("7d");
      expect(search.get("group")).toBe("model");
      expect(search.get("gval")).toBe("gpt-4o");
    });

    // Extra ticks must prove none of the three params ping-pongs out.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("bmode")).toBe("drillin");
    expect(settled.get("range")).toBe("7d");
    expect(settled.get("group")).toBe("model");
    expect(settled.get("gval")).toBe("gpt-4o");
    const settledParams = lastListParams();
    expect(settledParams.model).toBe("gpt-4o");
    expect(settledParams.from).toBe(expectedFrom);
    expect(settledParams.to).toBe(expectedTo);
    const settledBreakdown = lastBreakdownParams();
    expect(settledBreakdown.model).toBe("gpt-4o");
  });

  it("restores the drill-in breakdown mode from storage on a fresh visit with no link", async () => {
    // A returning visitor with no shared link: the URL carries no bmode param,
    // but localStorage remembers "drillin" from a prior visit. initialView()
    // finds nothing in the URL and falls back to the stored breakdownMode, so
    // the "Drill in" toggle starts active — the storage-only complement to the
    // cold-link restore above.
    window.localStorage.setItem(
      VIEW_STORAGE_KEY,
      JSON.stringify({ breakdownMode: "drillin" }),
    );
    // No bmode query param at all — a pure storage-only restore.
    window.history.replaceState({}, "", "/traces");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // The "Drill in" toggle is active purely from storage.
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");
    // ...and "Navigate" is correspondingly inactive.
    expect(screen.getByTestId("breakdown-mode-navigate")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // The URL-sync effect writes bmode=drillin back into the URL so the
    // remembered mode is shareable again, even though it arrived from storage.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBe("drillin");
    });

    // Extra ticks must prove the restored mode has settled rather than
    // ping-ponging back to the default "navigate" (which writes no bmode).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("bmode")).toBe("drillin");
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("lets an explicit bmode in the URL win over a stale stored breakdown mode on a cold load", async () => {
    // A cold-load race: localStorage remembers "navigate" from a prior visit,
    // but the shared link explicitly carries bmode=drillin. initialView() reads
    // the URL first (url.get("bmode") ?? stored.breakdownMode), so the link
    // wins over the stale storage value — mirroring the range storage-vs-link
    // precedence and proving a shared link is authoritative.
    window.localStorage.setItem(
      VIEW_STORAGE_KEY,
      JSON.stringify({ breakdownMode: "navigate" }),
    );
    window.history.replaceState({}, "", "/traces?bmode=drillin");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // The link's "drillin" wins over the stored "navigate".
    const drillin = await screen.findByTestId("breakdown-mode-drillin");
    expect(drillin).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("breakdown-mode-navigate")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // The URL keeps bmode=drillin; the stale stored value never overrides it.
    await waitFor(() => {
      const search = new URLSearchParams(window.location.search);
      expect(search.get("bmode")).toBe("drillin");
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = new URLSearchParams(window.location.search);
    expect(settled.get("bmode")).toBe("drillin");
    expect(screen.getByTestId("breakdown-mode-drillin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("asks for confirmation before clearing a view with multiple active filters", async () => {
    // Open on a shared link that already carries two distinct filters: a span
    // kind and an active cost-breakdown group. That is two of the things Reset
    // would wipe, so clicking Reset must guard against an accidental one-click
    // wipe with a confirm.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?kind=llm&group=model&gval=gpt-4o");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    // Both filters are live: the group chip is shown and the kind reaches the query.
    await screen.findByTestId("active-group-filter");
    await waitFor(() => {
      const params = lastListParams();
      expect(params.kind).toBe("llm");
      expect(params.model).toBe("gpt-4o");
    });

    // Clicking Reset does NOT immediately wipe the view; it opens a confirm.
    fireEvent.click(screen.getByTestId("button-reset-view"));
    expect(screen.getByTestId("dialog-confirm-reset")).toBeInTheDocument();
    // Nothing is cleared yet — the group chip is still on screen.
    expect(screen.getByTestId("active-group-filter")).toBeInTheDocument();

    // Cancelling keeps the carefully assembled view intact.
    fireEvent.click(screen.getByTestId("button-cancel-reset"));
    await waitFor(() => {
      expect(screen.queryByTestId("dialog-confirm-reset")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("active-group-filter")).toBeInTheDocument();
    expect(lastListParams().kind).toBe("llm");
    expect(lastListParams().model).toBe("gpt-4o");

    // Re-open and confirm: now the view is fully cleared.
    fireEvent.click(screen.getByTestId("button-reset-view"));
    fireEvent.click(screen.getByTestId("button-confirm-reset"));

    await waitFor(() => {
      expect(screen.queryByTestId("active-group-filter")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      const params = lastListParams();
      expect(params.kind).toBeUndefined();
      expect(params.model).toBeUndefined();
    });
    // The Reset control disappears once nothing is active.
    expect(screen.queryByTestId("button-reset-view")).not.toBeInTheDocument();
  });

  it("resets a single trivial filter immediately without a confirm", async () => {
    // Open on a shared link carrying exactly one filter — just a span kind.
    // Clearing a single filter is low-risk, so Reset should fire instantly with
    // no confirm dialog getting in the way.
    window.localStorage.clear();
    window.history.replaceState({}, "", "/traces?kind=llm");

    render(
      <DateRangeProvider>
        <Traces />
      </DateRangeProvider>,
    );

    await waitFor(() => {
      expect(lastListParams().kind).toBe("llm");
    });

    fireEvent.click(screen.getByTestId("button-reset-view"));

    // No confirm appears, and the filter is cleared straight away.
    expect(screen.queryByTestId("dialog-confirm-reset")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(lastListParams().kind).toBeUndefined();
    });
    expect(screen.queryByTestId("button-reset-view")).not.toBeInTheDocument();
  });
});
