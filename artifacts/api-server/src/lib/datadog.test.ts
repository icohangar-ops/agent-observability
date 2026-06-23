import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { searchSpans } from "./datadog";

// --- Datadog credentials are required by readConfig(); set fakes for tests. ---
process.env.DATADOG_SITE = "datadoghq.test";
process.env.DATADOG_API_KEY = "fake-api-key";
process.env.DATADOG_APP_KEY = "fake-app-key";

const realFetch = globalThis.fetch;

interface StubCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: StubCall[] = [];

// Replace global fetch with a stub that returns a caller-provided Response.
// searchSpans reads the global `fetch` at call time, so this captures every
// outbound Datadog request without touching the network.
function stubFetch(responder: () => Response | Promise<Response>) {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder();
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("maps the empty-org 'No valid indexes specified' 500 to noData with no spans", async () => {
  stubFetch(() =>
    jsonResponse({ errors: [{ detail: "No valid indexes specified" }] }, 500),
  );

  const result = await searchSpans({ from: "now-30d", to: "now" });

  assert.deepEqual(result, { spans: [], noData: true });
});

test("matches the no-index detail case-insensitively", async () => {
  stubFetch(() =>
    jsonResponse({ errors: [{ detail: "No Valid Indexes Specified for query" }] }, 500),
  );

  const result = await searchSpans({ from: "now-30d", to: "now" });

  assert.equal(result.noData, true);
  assert.deepEqual(result.spans, []);
});

test("normalizes a successful payload into flat spans", async () => {
  stubFetch(() =>
    jsonResponse({
      data: [
        {
          id: "event-1",
          attributes: {
            span_id: "span-1",
            trace_id: "trace-1",
            parent_id: "parent-1",
            name: "chat completion",
            span_kind: "llm",
            model_name: "gpt-4o",
            model_provider: "openai",
            status: "ok",
            ml_app: "support-bot",
            start_ns: 1_000_000_000, // 1000 ms epoch
            duration: 2_500_000, // 2.5 ms
            metrics: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            tags: ["env:prod", 42, "team:ai"],
          },
        },
      ],
    }),
  );

  const result = await searchSpans({ from: "now-30d", to: "now" });

  assert.equal(result.noData, false);
  assert.equal(result.spans.length, 1);
  const span = result.spans[0];
  assert.equal(span.spanId, "span-1");
  assert.equal(span.traceId, "trace-1");
  assert.equal(span.parentId, "parent-1");
  assert.equal(span.name, "chat completion");
  assert.equal(span.kind, "llm");
  assert.equal(span.model, "gpt-4o");
  assert.equal(span.provider, "openai");
  assert.equal(span.inputTokens, 10);
  assert.equal(span.outputTokens, 5);
  assert.equal(span.totalTokens, 15);
  assert.equal(span.latencyMs, 2.5);
  assert.equal(span.status, "ok");
  assert.equal(span.mlApp, "support-bot");
  assert.equal(span.timestamp, new Date(1000).toISOString());
  // Non-string tags are dropped.
  assert.deepEqual(span.tags, ["env:prod", "team:ai"]);
});

test("flattens llm messages while preserving role labels", async () => {
  stubFetch(() =>
    jsonResponse({
      data: [
        {
          id: "event-io",
          attributes: {
            span_kind: "llm",
            meta: {
              input: {
                messages: [
                  { role: "system", content: "You are helpful." },
                  { role: "user", content: "Hi" },
                ],
              },
              output: { messages: [{ role: "assistant", content: "Hello!" }] },
            },
          },
        },
      ],
    }),
  );

  const result = await searchSpans({ from: "now-30d", to: "now" });

  const span = result.spans[0];
  assert.equal(span.input, "system: You are helpful.\n\nuser: Hi");
  assert.equal(span.output, "assistant: Hello!");
});

test("flattens non-llm value inputs as plain text", async () => {
  stubFetch(() =>
    jsonResponse({
      data: [
        {
          id: "event-val",
          attributes: {
            span_kind: "tool",
            meta: { input: { value: "search query" }, output: { value: "result" } },
          },
        },
      ],
    }),
  );

  const result = await searchSpans({ from: "now-30d", to: "now" });

  assert.equal(result.spans[0].input, "search query");
  assert.equal(result.spans[0].output, "result");
});

test("derives totalTokens from input+output when Datadog omits it", async () => {
  stubFetch(() =>
    jsonResponse({
      data: [
        {
          id: "event-2",
          attributes: {
            span_kind: "agent",
            metrics: { input_tokens: 7, output_tokens: 3 },
          },
        },
      ],
    }),
  );

  const result = await searchSpans({ from: "now-30d", to: "now" });

  assert.equal(result.spans[0].totalTokens, 10);
});

test("applies sensible defaults for sparse span attributes", async () => {
  stubFetch(() =>
    jsonResponse({
      data: [{ id: "event-3", attributes: {} }],
    }),
  );

  const result = await searchSpans({ from: "now-30d", to: "now" });

  const span = result.spans[0];
  assert.equal(span.spanId, "event-3"); // falls back to the hit id
  assert.equal(span.traceId, "");
  assert.equal(span.parentId, null);
  assert.equal(span.name, "(unnamed span)");
  assert.equal(span.kind, "unknown");
  assert.equal(span.model, null);
  assert.equal(span.status, "ok");
  assert.equal(span.totalTokens, 0);
  assert.equal(span.latencyMs, 0);
  assert.equal(span.timestamp, new Date(0).toISOString());
  assert.deepEqual(span.tags, []);
});

test("returns an empty (but present) result set when data is empty", async () => {
  stubFetch(() => jsonResponse({ data: [] }));

  const result = await searchSpans({ from: "now-30d", to: "now" });

  assert.deepEqual(result, { spans: [], noData: false });
});

test("throws on a non-2xx response that is not the no-index case", async () => {
  stubFetch(() => jsonResponse({ errors: [{ detail: "Forbidden" }] }, 403));

  await assert.rejects(
    () => searchSpans({ from: "now-30d", to: "now" }),
    /status 403/,
  );
});

test("throws on a 500 that is not the no-index case", async () => {
  stubFetch(() => jsonResponse({ errors: [{ detail: "Internal error" }] }, 500));

  await assert.rejects(
    () => searchSpans({ from: "now-30d", to: "now" }),
    /status 500/,
  );
});

test("sends from/to as strings and an empty query by default", async () => {
  stubFetch(() => jsonResponse({ data: [] }));

  await searchSpans({ from: 1700000000000, to: 1700000005000 });

  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0].init?.body));
  const filter = body.data.attributes.filter;
  assert.equal(typeof filter.from, "string");
  assert.equal(typeof filter.to, "string");
  assert.equal(filter.from, "1700000000000");
  assert.equal(filter.to, "1700000005000");
  assert.equal(filter.query, "");
});
