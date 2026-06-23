import { Router, type IRouter } from "express";
import { searchSpans, type NormalizedSpan } from "../lib/datadog";

const router: IRouter = Router();

interface DateRange {
  from: string | null;
  to: string | null;
}

function parseRange(query: Record<string, unknown>): DateRange {
  const from =
    typeof query.from === "string" && query.from.trim() !== "" ? query.from.trim() : null;
  const to =
    typeof query.to === "string" && query.to.trim() !== "" ? query.to.trim() : null;
  return { from, to };
}

// Convert the dashboard's ISO date range (YYYY-MM-DD, inclusive) into the epoch
// millisecond bounds Datadog's Export API expects. `to` is treated as an
// inclusive calendar day. Falls back to a rolling 30-day window when unset.
function datadogBounds(range: DateRange): { from: number | string; to: number | string } {
  const from = range.from ? Date.parse(`${range.from}T00:00:00Z`) : "now-30d";
  const to = range.to ? Date.parse(`${range.to}T23:59:59.999Z`) : "now";
  return { from, to };
}

function singleString(value: unknown): string | null {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Apply kind + free-text filtering in-process so the list and the summary stay
// perfectly consistent regardless of Datadog query-syntax quirks.
function applyFilters(
  spans: NormalizedSpan[],
  kind: string | null,
  query: string | null,
): NormalizedSpan[] {
  let out = spans;
  if (kind) {
    out = out.filter((s) => s.kind === kind);
  }
  if (query) {
    const q = query.toLowerCase();
    out = out.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.model ?? "").toLowerCase().includes(q) ||
        (s.provider ?? "").toLowerCase().includes(q) ||
        s.kind.toLowerCase().includes(q) ||
        (s.mlApp ?? "").toLowerCase().includes(q),
    );
  }
  return out;
}

function summarize(spans: NormalizedSpan[]) {
  let errorCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let totalLatencyMs = 0;
  for (const s of spans) {
    if (s.status === "error") errorCount++;
    inputTokens += s.inputTokens;
    outputTokens += s.outputTokens;
    totalTokens += s.totalTokens;
    estimatedCostUsd += s.estimatedCostUsd;
    totalLatencyMs += s.latencyMs;
  }
  const spanCount = spans.length;
  return {
    spanCount,
    errorCount,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd,
    avgLatencyMs: spanCount > 0 ? totalLatencyMs / spanCount : 0,
  };
}

router.get("/traces", async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>);
  const kind = singleString(req.query.kind);
  const query = singleString(req.query.q);
  const bounds = datadogBounds(range);

  const { spans, noData } = await searchSpans({ from: bounds.from, to: bounds.to });
  const filtered = applyFilters(spans, kind, query);
  res.json({ noData, spans: filtered });
});

router.get("/traces/summary", async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>);
  const kind = singleString(req.query.kind);
  const query = singleString(req.query.q);
  const bounds = datadogBounds(range);

  const { spans, noData } = await searchSpans({ from: bounds.from, to: bounds.to });
  const filtered = applyFilters(spans, kind, query);
  res.json({ noData, ...summarize(filtered) });
});

export default router;
