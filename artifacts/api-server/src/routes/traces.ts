import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { searchSpans, type NormalizedSpan } from "../lib/datadog";
import { logger } from "../lib/logger";

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

interface CostGroup {
  key: string;
  cost: number;
  spanCount: number;
  totalTokens: number;
  costShare: number;
}

// Group spans by an arbitrary key (model or ml_app), summing the Datadog
// estimated cost and tokens, sorted by cost descending. `costShare` is each
// group's fraction of the total estimated cost across all spans (0-1).
function groupByCost(
  spans: NormalizedSpan[],
  keyOf: (s: NormalizedSpan) => string,
): CostGroup[] {
  const totalCost = spans.reduce((acc, s) => acc + s.estimatedCostUsd, 0);
  const map = new Map<string, { cost: number; spanCount: number; totalTokens: number }>();
  for (const s of spans) {
    const key = keyOf(s);
    const entry = map.get(key) ?? { cost: 0, spanCount: 0, totalTokens: 0 };
    entry.cost += s.estimatedCostUsd;
    entry.spanCount += 1;
    entry.totalTokens += s.totalTokens;
    map.set(key, entry);
  }
  return Array.from(map.entries())
    .map(([key, v]) => ({
      key,
      cost: v.cost,
      spanCount: v.spanCount,
      totalTokens: v.totalTokens,
      costShare: totalCost > 0 ? v.cost / totalCost : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

// Cache the ml_app → department map briefly. The breakdown route is low-traffic
// but called once per page load; a short TTL avoids a DB round-trip on every hit
// while still picking up org/directory changes within a minute.
const DEPT_MAP_TTL_MS = 60_000;
let deptMapCache: { map: Map<string, string>; expires: number } | null = null;

// Build a map from agent id (the value carried in a span's ml_app) to its owning
// department name, joining agents → employees → departments. On any DB error we
// return an empty map so department grouping degrades gracefully (everything
// falls back to tags or "(unattributed)") instead of failing the whole route.
async function loadDepartmentMap(): Promise<Map<string, string>> {
  if (deptMapCache && deptMapCache.expires > Date.now()) {
    return deptMapCache.map;
  }
  const map = new Map<string, string>();
  try {
    const q = await pool.query<{ agent_id: string; dept_name: string }>(
      `SELECT a.id AS agent_id, d.name AS dept_name
         FROM agents a
         JOIN employees e ON e.id = a.employee_id
         JOIN departments d ON d.id = e.department_id`,
    );
    for (const row of q.rows) {
      map.set(row.agent_id, row.dept_name);
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load department map for trace cost breakdown");
  }
  deptMapCache = { map, expires: Date.now() + DEPT_MAP_TTL_MS };
  return map;
}

const DEPT_TAG_RE = /^(?:department|dept|team):(.+)$/i;

// Derive the department/team for a span. Prefer an explicit department/dept/team
// span tag, then fall back to mapping the span's ml_app to its owning agent's
// department. Spans with neither are bucketed under "(unattributed)" so they
// remain visible rather than silently dropped.
function departmentOf(span: NormalizedSpan, mlAppToDept: Map<string, string>): string {
  for (const tag of span.tags) {
    const m = DEPT_TAG_RE.exec(tag);
    if (m && m[1].trim() !== "") return m[1].trim();
  }
  if (span.mlApp) {
    const dept = mlAppToDept.get(span.mlApp);
    if (dept) return dept;
  }
  return "(unattributed)";
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

interface GroupFilter {
  model: string | null;
  app: string | null;
  department: string | null;
}

function parseGroupFilter(query: Record<string, unknown>): GroupFilter {
  return {
    model: singleString(query.model),
    app: singleString(query.app),
    department: singleString(query.department),
  };
}

// Narrow spans to a single breakdown group (model, ml_app, or department), using
// the exact sentinel keys the breakdown emits so a clicked card row maps 1:1 to
// the spans behind it. Department needs the agent→department map; we only load
// it when a department filter is actually requested. Returns the spans unchanged
// when no group filter is set.
async function applyGroupFilter(
  spans: NormalizedSpan[],
  group: GroupFilter,
): Promise<NormalizedSpan[]> {
  let out = spans;
  if (group.model) {
    out = out.filter((s) => (s.model ?? "(no model)") === group.model);
  }
  if (group.app) {
    out = out.filter((s) => (s.mlApp ?? "(no app)") === group.app);
  }
  if (group.department) {
    const mlAppToDept = await loadDepartmentMap();
    out = out.filter((s) => departmentOf(s, mlAppToDept) === group.department);
  }
  return out;
}

router.get("/traces", async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>);
  const kind = singleString(req.query.kind);
  const query = singleString(req.query.q);
  const group = parseGroupFilter(req.query as Record<string, unknown>);
  const bounds = datadogBounds(range);

  const { spans, noData } = await searchSpans({ from: bounds.from, to: bounds.to });
  const filtered = await applyGroupFilter(applyFilters(spans, kind, query), group);
  res.json({ noData, spans: filtered });
});

router.get("/traces/summary", async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>);
  const kind = singleString(req.query.kind);
  const query = singleString(req.query.q);
  const group = parseGroupFilter(req.query as Record<string, unknown>);
  const bounds = datadogBounds(range);

  const { spans, noData } = await searchSpans({ from: bounds.from, to: bounds.to });
  const filtered = await applyGroupFilter(applyFilters(spans, kind, query), group);
  res.json({ noData, ...summarize(filtered) });
});

router.get("/traces/breakdown", async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>);
  const kind = singleString(req.query.kind);
  const query = singleString(req.query.q);
  const bounds = datadogBounds(range);

  const { spans, noData } = await searchSpans({ from: bounds.from, to: bounds.to });
  const filtered = applyFilters(spans, kind, query);
  const mlAppToDept = await loadDepartmentMap();
  const byModel = groupByCost(filtered, (s) => s.model ?? "(no model)");
  const byApp = groupByCost(filtered, (s) => s.mlApp ?? "(no app)");
  const byDepartment = groupByCost(filtered, (s) => departmentOf(s, mlAppToDept));
  res.json({ noData, byModel, byApp, byDepartment });
});

// Per-trace drill-down: every span sharing a traceId, ordered by start time, plus
// wall-clock bounds for rendering a waterfall. Declared after the literal
// /traces/summary and /traces/breakdown routes so those win over this
// parameterized one.
router.get("/traces/:traceId", async (req, res) => {
  const range = parseRange(req.query as Record<string, unknown>);
  const bounds = datadogBounds(range);
  const { traceId } = req.params;

  // Filter by trace_id at the Datadog query layer so the global page limit never
  // truncates a trace's spans (a generic page sorted by -timestamp could drop
  // spans of an older trace). traceIds are decimal numeric strings — no escaping.
  const { spans, noData } = await searchSpans({
    from: bounds.from,
    to: bounds.to,
    query: `@trace_id:${traceId}`,
  });
  const traceSpans = spans
    .filter((s) => s.traceId === traceId)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const s of traceSpans) {
    const start = Date.parse(s.timestamp);
    if (!Number.isFinite(start)) continue;
    startMs = Math.min(startMs, start);
    endMs = Math.max(endMs, start + s.latencyMs);
  }
  const hasBounds = Number.isFinite(startMs) && Number.isFinite(endMs);

  res.json({
    traceId,
    noData,
    found: traceSpans.length > 0,
    startTime: hasBounds ? new Date(startMs).toISOString() : null,
    endTime: hasBounds ? new Date(endMs).toISOString() : null,
    durationMs: hasBounds ? endMs - startMs : 0,
    spans: traceSpans,
    ...summarize(traceSpans),
  });
});

export default router;
