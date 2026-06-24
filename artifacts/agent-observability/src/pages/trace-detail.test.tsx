import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TraceDetail as TraceDetailData, TraceSpan } from "@workspace/api-client-react";

const useGetTrace = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetTrace: (...args: unknown[]) => useGetTrace(...args),
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
  useParams: () => ({ traceId: "trace-1" }),
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

import TraceDetail from "./trace-detail";
import { Toaster } from "@/components/ui/toaster";

type QueryResult<T> = { data: T | undefined; isLoading: boolean };

const TRACE_START = "2024-01-01T00:00:00.000Z";

function span(over: Partial<TraceSpan> & Pick<TraceSpan, "spanId" | "name">): TraceSpan {
  return {
    traceId: "trace-1",
    parentId: null,
    kind: "agent",
    model: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    latencyMs: 1000,
    status: "ok",
    timestamp: TRACE_START,
    mlApp: null,
    tags: [],
    input: null,
    output: null,
    ...over,
  };
}

// A small nested trace: root -> child -> grandchild. Offsets/latencies are
// chosen so the linear projection produces round percentages:
//   root       offset   0ms, lasts 1000ms -> left   0%, width 100%
//   child      offset 250ms, lasts  500ms -> left  25%, width  50%
//   grandchild offset 500ms, lasts  250ms -> left  50%, width  25%
const NESTED_SPANS: TraceSpan[] = [
  span({ spanId: "root", name: "root", latencyMs: 1000, timestamp: TRACE_START }),
  span({
    spanId: "child",
    name: "child",
    parentId: "root",
    latencyMs: 500,
    timestamp: "2024-01-01T00:00:00.250Z",
  }),
  span({
    spanId: "grandchild",
    name: "grandchild",
    parentId: "child",
    latencyMs: 250,
    timestamp: "2024-01-01T00:00:00.500Z",
  }),
];

function traceResult(over: Partial<QueryResult<TraceDetailData>> = {}): QueryResult<TraceDetailData> {
  return {
    data: {
      traceId: "trace-1",
      noData: false,
      found: true,
      startTime: TRACE_START,
      endTime: "2024-01-01T00:00:01.000Z",
      durationMs: 1000,
      spans: NESTED_SPANS,
      spanCount: NESTED_SPANS.length,
      errorCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      avgLatencyMs: 583,
    },
    isLoading: false,
    ...over,
  };
}

// Resolve the span-name column container that carries the depth indentation.
// Scoped to the span's own row so it never matches the breadcrumb/title, which
// reuse the root span's name elsewhere on the page.
function indentContainer(spanId: string): HTMLElement {
  const row = screen.getByTestId(`row-trace-span-${spanId}`);
  const container = row.querySelector("div[style]");
  if (!(container instanceof HTMLElement)) {
    throw new Error(`No indent container for span "${spanId}"`);
  }
  return container;
}

// Resolve the colored bar element (the inner positioned div) for a span row.
function barElement(spanId: string): HTMLElement {
  const zoomButton = screen.getByTestId(`button-zoom-span-${spanId}`);
  const bar = zoomButton.querySelector("div[style]");
  if (!(bar instanceof HTMLElement)) throw new Error(`No bar for span "${spanId}"`);
  return bar;
}

describe("TraceDetail span timeline nesting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGetTrace.mockReturnValue(traceResult());
  });

  it("indents nested spans by depth * 16px", () => {
    render(<TraceDetail />);

    expect(indentContainer("root").style.paddingLeft).toBe("0px");
    expect(indentContainer("child").style.paddingLeft).toBe("16px");
    expect(indentContainer("grandchild").style.paddingLeft).toBe("32px");
  });

  it("increases indentation strictly with nesting depth", () => {
    render(<TraceDetail />);

    const pad = (spanId: string) => parseFloat(indentContainer(spanId).style.paddingLeft);
    expect(pad("root")).toBeLessThan(pad("child"));
    expect(pad("child")).toBeLessThan(pad("grandchild"));
  });

  it("positions each span's bar at the projected offset and width", () => {
    render(<TraceDetail />);

    const root = barElement("root");
    expect(root.style.left).toBe("0%");
    expect(root.style.width).toBe("100%");

    const child = barElement("child");
    expect(child.style.left).toBe("25%");
    expect(child.style.width).toBe("50%");

    const grandchild = barElement("grandchild");
    expect(grandchild.style.left).toBe("50%");
    expect(grandchild.style.width).toBe("25%");
  });

  it("keeps the bar offset independent of the row's depth indentation", () => {
    render(<TraceDetail />);

    // The deepest span is indented the most but its bar still starts where the
    // projected offset puts it (50%), not pushed by the 32px label padding.
    expect(indentContainer("grandchild").style.paddingLeft).toBe("32px");
    expect(barElement("grandchild").style.left).toBe("50%");
  });
});

describe("TraceDetail copy toast auto-dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A single span carrying JSON input so the IOBlock renders its CopyButton.
    const base = traceResult().data!;
    useGetTrace.mockReturnValue({
      data: {
        ...base,
        spans: [span({ spanId: "root", name: "root", input: '{"q":"hi"}' })],
        spanCount: 1,
        errorCount: 0,
      },
      isLoading: false,
    });
  });

  it("auto-dismisses the copy toast after the default window when the user does nothing", async () => {
    // The copy toast sets no explicit duration, so it leans entirely on the
    // shared toast component's default auto-dismiss. A regression that bumps
    // that default (or sets it to Infinity) would leave this toast pinned
    // forever, so guard that it clears itself with no user action.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    render(
      <>
        <TraceDetail />
        <Toaster />
      </>,
    );

    // Expand the span row to reveal the Copy button, then trigger a copy.
    fireEvent.click(screen.getByTestId("row-trace-span-root"));
    const copyButton = screen.getByTestId("button-copy-input-root");

    vi.useFakeTimers();
    try {
      fireEvent.click(copyButton);

      // The clipboard write rejects on a microtask; flush it so the catch
      // dispatches the toast before we start advancing fake timers.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("Couldn't copy to clipboard")).toBeInTheDocument();

      // Just before the default auto-dismiss window elapses it is still shown.
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.getByText("Couldn't copy to clipboard")).toBeInTheDocument();

      // Once the default window passes, the toast dismisses itself.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText("Couldn't copy to clipboard")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
