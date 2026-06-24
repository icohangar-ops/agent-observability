import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import app from "../app";

// --- Datadog credentials are required by readConfig(); set fakes for tests. ---
process.env.DATADOG_SITE = "datadoghq.test";
process.env.DATADOG_API_KEY = "fake-api-key";
process.env.DATADOG_APP_KEY = "fake-app-key";

// realFetch is used to call our own server; the global fetch is stubbed so the
// route's Datadog call returns canned data instead of hitting the network.
const realFetch = globalThis.fetch;

// What the stubbed Datadog endpoint should return for the next route call.
let nextDatadog: () => Response = () =>
  new Response(JSON.stringify({ data: [] }), { status: 200 });

// The parsed request body of the most recent Datadog call, so tests can assert
// what query/time bounds the route forwarded to Datadog.
let lastDatadogBody: {
  data?: { attributes?: { filter?: { from?: string; to?: string; query?: string } } };
} | null = null;

globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  // Only intercept the Datadog Export API; let everything else hit the network
  // (the test never relies on that path, but it keeps the stub honest).
  if (u.includes("/api/v2/llm-obs/")) {
    lastDatadogBody = init?.body ? JSON.parse(String(init.body)) : null;
    return nextDatadog();
  }
  return realFetch(u, init);
}) as typeof fetch;

interface TraceListResponse {
  noData: boolean;
  spans: Array<{ spanId: string; kind: string }>;
}

interface TraceSummaryResponse {
  noData: boolean;
  spanCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

interface TraceDetailResponse {
  traceId: string;
  noData: boolean;
  found: boolean;
  startTime: string | null;
  endTime: string | null;
  durationMs: number;
  spans: Array<{ spanId: string; traceId: string }>;
  spanCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

interface TraceCostGroup {
  key: string;
  cost: number;
  spanCount: number;
  totalTokens: number;
  costShare: number;
}

interface TraceBreakdownResponse {
  noData: boolean;
  byModel: TraceCostGroup[];
  byApp: TraceCostGroup[];
  byDepartment: TraceCostGroup[];
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await realFetch(url);
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

// Floating-point safe equality for summed USD costs / shares.
function approx(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

function spanIds(body: TraceListResponse): string[] {
  return body.spans.map((s) => s.spanId);
}

function datadogSpans(
  spans: Array<Record<string, unknown>>,
  status = 200,
): () => Response {
  return () =>
    new Response(
      JSON.stringify({ data: spans.map((attributes, i) => ({ id: `e${i}`, attributes })) }),
      { status, headers: { "Content-Type": "application/json" } },
    );
}

function noIndexError(): Response {
  return new Response(
    JSON.stringify({ errors: [{ detail: "No valid indexes specified" }] }),
    { status: 500 },
  );
}

const SAMPLE = [
  {
    span_id: "s1",
    name: "gpt call",
    span_kind: "llm",
    model_name: "gpt-4o",
    model_provider: "openai",
    status: "ok",
    ml_app: "support-bot",
    duration: 1_000_000, // 1 ms
    metrics: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  },
  {
    span_id: "s2",
    name: "planner step",
    span_kind: "agent",
    model_name: null,
    model_provider: null,
    status: "error",
    ml_app: "support-bot",
    duration: 3_000_000, // 3 ms
    metrics: { input_tokens: 20, output_tokens: 0, total_tokens: 20 },
  },
  {
    span_id: "s3",
    name: "claude call",
    span_kind: "llm",
    model_name: "claude-3",
    model_provider: "anthropic",
    status: "ok",
    ml_app: "billing-agent",
    duration: 2_000_000, // 2 ms
    metrics: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
  },
];

describe("traces routes", () => {
  let server: Server;
  let base: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        base = `http://127.0.0.1:${port}/api`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    nextDatadog = datadogSpans(SAMPLE);
  });

  test("GET /traces returns all spans when no filters are given", async () => {
    const { status, body } = await getJson<TraceListResponse>(`${base}/traces`);
    assert.equal(status, 200);
    assert.equal(body.noData, false);
    assert.equal(body.spans.length, 3);
  });

  test("GET /traces?kind=llm filters by span kind", async () => {
    const { body } = await getJson<TraceListResponse>(`${base}/traces?kind=llm`);
    assert.equal(body.spans.length, 2);
    assert.ok(body.spans.every((s) => s.kind === "llm"));
  });

  test("GET /traces?q matches name, model, provider, kind and mlApp", async () => {
    // model match
    assert.deepEqual(
      spanIds((await getJson<TraceListResponse>(`${base}/traces?q=claude`)).body),
      ["s3"],
    );

    // provider match
    assert.deepEqual(
      spanIds((await getJson<TraceListResponse>(`${base}/traces?q=openai`)).body),
      ["s1"],
    );

    // mlApp match
    assert.deepEqual(
      spanIds((await getJson<TraceListResponse>(`${base}/traces?q=billing`)).body),
      ["s3"],
    );

    // kind match (free text, case-insensitive): s2 matches via its kind
    // ("agent") and s3 via its mlApp ("billing-agent").
    assert.deepEqual(
      spanIds((await getJson<TraceListResponse>(`${base}/traces?q=AGENT`)).body),
      ["s2", "s3"],
    );

    // name match
    assert.deepEqual(
      spanIds((await getJson<TraceListResponse>(`${base}/traces?q=planner`)).body),
      ["s2"],
    );
  });

  test("GET /traces combines kind and q filters", async () => {
    // Only s1 is both kind=llm AND matches "support" (ml_app support-bot).
    const { body } = await getJson<TraceListResponse>(`${base}/traces?kind=llm&q=support`);
    assert.deepEqual(spanIds(body), ["s1"]);
  });

  test("GET /traces/summary aggregates counts, tokens and average latency", async () => {
    const { body } = await getJson<TraceSummaryResponse>(`${base}/traces/summary`);
    assert.equal(body.noData, false);
    assert.equal(body.spanCount, 3);
    assert.equal(body.errorCount, 1);
    assert.equal(body.inputTokens, 60);
    assert.equal(body.outputTokens, 15);
    assert.equal(body.totalTokens, 75);
    // (1 + 3 + 2) ms / 3 spans = 2 ms average.
    assert.equal(body.avgLatencyMs, 2);
  });

  test("GET /traces/summary respects filters", async () => {
    const { body } = await getJson<TraceSummaryResponse>(`${base}/traces/summary?kind=llm`);
    assert.equal(body.spanCount, 2);
    assert.equal(body.errorCount, 0);
    assert.equal(body.inputTokens, 40);
    assert.equal(body.outputTokens, 15);
    assert.equal(body.totalTokens, 55);
    // (1 + 2) ms / 2 spans = 1.5 ms average.
    assert.equal(body.avgLatencyMs, 1.5);
  });

  test("GET /traces/breakdown groups estimated cost by model, app and department", async () => {
    // Spans carry estimated cost (micro-dollars) and explicit department tags so
    // the grouping is deterministic without depending on the directory DB.
    nextDatadog = datadogSpans([
      {
        span_id: "b1",
        name: "gpt call",
        span_kind: "llm",
        model_name: "gpt-4o",
        ml_app: "support-bot",
        duration: 1_000_000,
        tags: ["department:Engineering"],
        metrics: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated_total_cost: 3_000_000 },
      },
      {
        span_id: "b2",
        name: "gpt mini",
        span_kind: "llm",
        model_name: "gpt-4o",
        ml_app: "billing-agent",
        duration: 1_000_000,
        tags: ["team:Finance"],
        metrics: { input_tokens: 4, output_tokens: 1, total_tokens: 5, estimated_total_cost: 1_000_000 },
      },
      {
        span_id: "b3",
        name: "claude call",
        span_kind: "llm",
        model_name: "claude-3",
        ml_app: "support-bot",
        duration: 1_000_000,
        tags: ["dept:Engineering"],
        metrics: { input_tokens: 2, output_tokens: 1, total_tokens: 3, estimated_total_cost: 2_000_000 },
      },
    ]);

    const { status, body } = await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown`);
    assert.equal(status, 200);
    assert.equal(body.noData, false);

    // Total cost = $6. By model: gpt-4o $4 (b1+b2), claude-3 $2 (b3).
    assert.deepEqual(
      body.byModel.map((g) => [g.key, g.cost]),
      [
        ["gpt-4o", 4],
        ["claude-3", 2],
      ],
    );

    // By department: Engineering $5 (b1+b3, via department:/dept: tags), Finance $1 (team: tag).
    assert.deepEqual(
      body.byDepartment.map((g) => [g.key, g.cost, g.spanCount]),
      [
        ["Engineering", 5, 2],
        ["Finance", 1, 1],
      ],
    );
    // Cost share is each group's fraction of the $6 total.
    assert.ok(Math.abs(body.byDepartment[0].costShare - 5 / 6) < 1e-9);
  });

  test("GET /traces/breakdown buckets spans without department attribution as unattributed", async () => {
    // No department/team tags; ml_app values don't match any seeded agent id, so
    // every span falls back to the (unattributed) bucket.
    nextDatadog = datadogSpans([
      {
        span_id: "u1",
        name: "gpt call",
        span_kind: "llm",
        model_name: "gpt-4o",
        ml_app: "no-such-agent",
        duration: 1_000_000,
        metrics: { input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated_total_cost: 5_000_000 },
      },
    ]);

    const { body } = await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown`);
    assert.deepEqual(
      body.byDepartment.map((g) => g.key),
      ["(unattributed)"],
    );
    assert.equal(body.byDepartment[0].cost, 5);
  });

  test("GET /traces/breakdown respects kind and search filters", async () => {
    nextDatadog = datadogSpans([
      {
        span_id: "f1",
        name: "gpt call",
        span_kind: "llm",
        model_name: "gpt-4o",
        ml_app: "support-bot",
        duration: 1_000_000,
        tags: ["department:Engineering"],
        metrics: { input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated_total_cost: 4_000_000 },
      },
      {
        span_id: "f2",
        name: "planner step",
        span_kind: "agent",
        ml_app: "support-bot",
        duration: 1_000_000,
        tags: ["department:Sales"],
        metrics: { input_tokens: 1, output_tokens: 0, total_tokens: 1, estimated_total_cost: 9_000_000 },
      },
    ]);

    // kind=llm drops the agent span, leaving only the Engineering department.
    const { body } = await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown?kind=llm`);
    assert.deepEqual(
      body.byDepartment.map((g) => [g.key, g.cost]),
      [["Engineering", 4]],
    );
  });

  test("GET /traces/breakdown reports empty groups when there is no data", async () => {
    nextDatadog = noIndexError;
    const { body } = await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown`);
    assert.equal(body.noData, true);
    assert.deepEqual(body.byModel, []);
    assert.deepEqual(body.byApp, []);
    assert.deepEqual(body.byDepartment, []);
  });

  test("GET /traces passes through Datadog's empty-org no-data state", async () => {
    nextDatadog = noIndexError;
    const { body } = await getJson<TraceListResponse>(`${base}/traces`);
    assert.equal(body.noData, true);
    assert.deepEqual(body.spans, []);
  });

  test("GET /traces/summary reports zeroed aggregates when there is no data", async () => {
    nextDatadog = noIndexError;
    const { body } = await getJson<TraceSummaryResponse>(`${base}/traces/summary`);
    assert.equal(body.noData, true);
    assert.equal(body.spanCount, 0);
    assert.equal(body.avgLatencyMs, 0);
  });

  // --- GET /traces/:traceId --------------------------------------------------

  // Three spans of trace "777" returned out of start-time order, plus a span
  // from a different trace that the route must filter out in-process. start_ns
  // is nanoseconds; the route orders by start time and computes wall-clock
  // bounds (min start, max start+latency).
  const TRACE_SPANS = [
    {
      span_id: "mid",
      trace_id: "777",
      name: "planner step",
      span_kind: "agent",
      status: "error",
      start_ns: 1_700_000_001_000_000_000, // +1s
      duration: 2_000_000, // 2 ms
      metrics: { input_tokens: 20, output_tokens: 0, total_tokens: 20 },
    },
    {
      span_id: "first",
      trace_id: "777",
      name: "gpt call",
      span_kind: "llm",
      model_name: "gpt-4o",
      status: "ok",
      start_ns: 1_700_000_000_000_000_000, // +0s (earliest)
      duration: 1_000_000, // 1 ms
      metrics: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
    {
      span_id: "last",
      trace_id: "777",
      name: "claude call",
      span_kind: "llm",
      model_name: "claude-3",
      status: "ok",
      start_ns: 1_700_000_002_000_000_000, // +2s (latest)
      duration: 3_000_000, // 3 ms
      metrics: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
    },
    {
      span_id: "other-trace",
      trace_id: "999",
      name: "unrelated",
      span_kind: "llm",
      status: "ok",
      start_ns: 1_700_000_003_000_000_000,
      duration: 9_000_000,
      metrics: { input_tokens: 99, output_tokens: 99, total_tokens: 198 },
    },
  ];

  test("GET /traces/:traceId returns ordered spans, bounds and aggregates", async () => {
    nextDatadog = datadogSpans(TRACE_SPANS);
    const { status, body } = await getJson<TraceDetailResponse>(`${base}/traces/777`);
    assert.equal(status, 200);
    assert.equal(body.noData, false);
    assert.equal(body.found, true);
    assert.equal(body.traceId, "777");

    // Spans of trace 777 only, ordered by start time ascending; the 999 span is
    // dropped by the in-process trace_id filter.
    assert.deepEqual(
      body.spans.map((s) => s.spanId),
      ["first", "mid", "last"],
    );
    assert.ok(body.spans.every((s) => s.traceId === "777"));

    // Aggregates exclude the foreign span.
    assert.equal(body.spanCount, 3);
    assert.equal(body.errorCount, 1);
    assert.equal(body.inputTokens, 60);
    assert.equal(body.outputTokens, 15);
    assert.equal(body.totalTokens, 75);
    // (1 + 2 + 3) ms / 3 spans = 2 ms average.
    assert.equal(body.avgLatencyMs, 2);

    // Wall-clock bounds: earliest start = first span's start; latest end =
    // last span's start + its 3 ms latency. Duration spans the whole window.
    const startMs = 1_700_000_000_000;
    const endMs = 1_700_000_002_000 + 3;
    assert.equal(body.startTime, new Date(startMs).toISOString());
    assert.equal(body.endTime, new Date(endMs).toISOString());
    assert.equal(body.durationMs, endMs - startMs);

    // The route scopes the Datadog query to the requested trace so the page
    // limit can't truncate a trace's spans.
    assert.equal(lastDatadogBody?.data?.attributes?.filter?.query, "@trace_id:777");
  });

  test("GET /traces/:traceId returns the not-found state for an unknown trace", async () => {
    // Datadog returns nothing for this trace id.
    nextDatadog = datadogSpans([]);
    const { status, body } = await getJson<TraceDetailResponse>(`${base}/traces/does-not-exist`);
    assert.equal(status, 200);
    assert.equal(body.found, false);
    assert.equal(body.traceId, "does-not-exist");
    assert.deepEqual(body.spans, []);
    assert.equal(body.spanCount, 0);
    assert.equal(body.startTime, null);
    assert.equal(body.endTime, null);
    assert.equal(body.durationMs, 0);
    assert.equal(body.avgLatencyMs, 0);
  });

  test("GET /traces/:traceId forwards the date range to Datadog", async () => {
    nextDatadog = datadogSpans(TRACE_SPANS);
    await getJson<TraceDetailResponse>(`${base}/traces/777?from=2026-01-01&to=2026-01-31`);

    // The ISO range is converted to inclusive epoch-millisecond bounds (start of
    // `from` day through end of `to` day) and sent as strings.
    const expectedFrom = String(Date.parse("2026-01-01T00:00:00Z"));
    const expectedTo = String(Date.parse("2026-01-31T23:59:59.999Z"));
    assert.equal(lastDatadogBody?.data?.attributes?.filter?.from, expectedFrom);
    assert.equal(lastDatadogBody?.data?.attributes?.filter?.to, expectedTo);
  });

  test("GET /traces/:traceId defaults to a rolling 30-day window when no range is given", async () => {
    nextDatadog = datadogSpans(TRACE_SPANS);
    await getJson<TraceDetailResponse>(`${base}/traces/777`);
    assert.equal(lastDatadogBody?.data?.attributes?.filter?.from, "now-30d");
    assert.equal(lastDatadogBody?.data?.attributes?.filter?.to, "now");
  });

  // --- GET /traces/breakdown -------------------------------------------------

  // Four spans whose Datadog estimated costs (micro-dollars) sum to exactly
  // $1.00, so each group's costShare equals its USD cost numerically. One span
  // has neither a model nor an ml_app to exercise the "(no model)"/"(no app)"
  // fallback keys.
  const COST_SPANS = [
    {
      span_id: "a",
      name: "gpt big",
      span_kind: "llm",
      model_name: "gpt-4o",
      model_provider: "openai",
      status: "ok",
      ml_app: "support-bot",
      duration: 1_000_000,
      metrics: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated_total_cost: 500_000 }, // $0.50
    },
    {
      span_id: "b",
      name: "gpt small",
      span_kind: "llm",
      model_name: "gpt-4o",
      model_provider: "openai",
      status: "ok",
      ml_app: "billing-agent",
      duration: 1_000_000,
      metrics: { input_tokens: 10, output_tokens: 10, total_tokens: 20, estimated_total_cost: 200_000 }, // $0.20
    },
    {
      span_id: "c",
      name: "claude call",
      span_kind: "agent",
      model_name: "claude-3",
      model_provider: "anthropic",
      status: "ok",
      ml_app: "support-bot",
      duration: 1_000_000,
      metrics: { input_tokens: 30, output_tokens: 10, total_tokens: 40, estimated_total_cost: 200_000 }, // $0.20
    },
    {
      span_id: "d",
      name: "bare step",
      span_kind: "agent",
      model_name: null,
      model_provider: null,
      status: "ok",
      ml_app: null,
      duration: 1_000_000,
      metrics: { input_tokens: 20, output_tokens: 0, total_tokens: 20, estimated_total_cost: 100_000 }, // $0.10
    },
  ];

  test("GET /traces/breakdown groups by model, sorted by cost descending", async () => {
    nextDatadog = datadogSpans(COST_SPANS);
    const { status, body } = await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown`);
    assert.equal(status, 200);
    assert.equal(body.noData, false);

    // gpt-4o (a+b = $0.70) > claude-3 ($0.20) > (no model) ($0.10).
    assert.deepEqual(
      body.byModel.map((g) => g.key),
      ["gpt-4o", "claude-3", "(no model)"],
    );

    const [gpt, claude, noModel] = body.byModel;
    approx(gpt.cost, 0.7);
    assert.equal(gpt.spanCount, 2);
    assert.equal(gpt.totalTokens, 35);
    approx(gpt.costShare, 0.7);

    approx(claude.cost, 0.2);
    assert.equal(claude.spanCount, 1);
    assert.equal(claude.totalTokens, 40);
    approx(claude.costShare, 0.2);

    // The model-less span falls back to the "(no model)" key.
    assert.equal(noModel.key, "(no model)");
    approx(noModel.cost, 0.1);
    assert.equal(noModel.spanCount, 1);
    approx(noModel.costShare, 0.1);
  });

  test("GET /traces/breakdown groups by app, sorted by cost descending", async () => {
    nextDatadog = datadogSpans(COST_SPANS);
    const { body } = await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown`);

    // support-bot (a+c = $0.70) > billing-agent ($0.20) > (no app) ($0.10).
    assert.deepEqual(
      body.byApp.map((g) => g.key),
      ["support-bot", "billing-agent", "(no app)"],
    );

    const [support, billing, noApp] = body.byApp;
    approx(support.cost, 0.7);
    assert.equal(support.spanCount, 2);
    assert.equal(support.totalTokens, 55);
    approx(support.costShare, 0.7);

    approx(billing.cost, 0.2);
    assert.equal(billing.spanCount, 1);

    // The app-less span falls back to the "(no app)" key.
    assert.equal(noApp.key, "(no app)");
    approx(noApp.cost, 0.1);
    assert.equal(noApp.spanCount, 1);
  });

  test("GET /traces/breakdown costShare sums to ~1 across each grouping", async () => {
    nextDatadog = datadogSpans(COST_SPANS);
    const { body } = await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown`);
    approx(body.byModel.reduce((acc, g) => acc + g.costShare, 0), 1);
    approx(body.byApp.reduce((acc, g) => acc + g.costShare, 0), 1);
  });

  test("GET /traces/breakdown respects kind and q filters", async () => {
    nextDatadog = datadogSpans(COST_SPANS);

    // kind=llm keeps only a + b, both gpt-4o ($0.50 + $0.20).
    const llm = (await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown?kind=llm`)).body;
    assert.deepEqual(
      llm.byModel.map((g) => g.key),
      ["gpt-4o"],
    );
    approx(llm.byModel[0].cost, 0.7);
    assert.equal(llm.byModel[0].spanCount, 2);
    // With only gpt-4o left, its share is the whole pie.
    approx(llm.byModel[0].costShare, 1);
    assert.deepEqual(
      llm.byApp.map((g) => g.key).sort(),
      ["billing-agent", "support-bot"],
    );

    // q=claude keeps only span c.
    const claude = (await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown?q=claude`)).body;
    assert.deepEqual(
      claude.byModel.map((g) => g.key),
      ["claude-3"],
    );
    approx(claude.byModel[0].cost, 0.2);
    approx(claude.byModel[0].costShare, 1);
  });

  test("GET /traces/breakdown returns empty groups in the no-data state", async () => {
    nextDatadog = noIndexError;
    const { body } = await getJson<TraceBreakdownResponse>(`${base}/traces/breakdown`);
    assert.equal(body.noData, true);
    assert.deepEqual(body.byModel, []);
    assert.deepEqual(body.byApp, []);
  });
});
