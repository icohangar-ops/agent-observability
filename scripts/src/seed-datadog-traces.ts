/**
 * Seed clearly-labeled sample agent traces into Datadog LLM Observability.
 *
 * The connected Datadog org has no real LLM Obs data, so this sends a handful of
 * synthetic agent/LLM spans (ml_app "agentops-samples", tag sample:true) to the
 * LLM Observability ingestion API. The dashboard's Traces page then has real data
 * to read back through the Export API.
 *
 * This is the ONE place AgentOps writes to Datadog — and only sample data. The
 * live dashboard path stays strictly read-only.
 *
 * Run: pnpm --filter @workspace/scripts run seed:traces
 */

const SITE = process.env.DATADOG_SITE;
const API_KEY = process.env.DATADOG_API_KEY;

if (!SITE || !API_KEY) {
  console.error("DATADOG_SITE and DATADOG_API_KEY must be set to seed sample traces.");
  process.exit(1);
}

const ML_APP = "agentops-samples";
const SAMPLE_TAGS = ["sample:true", "env:demo"];

interface SampleSpan {
  name: string;
  kind: "agent" | "workflow" | "llm" | "tool" | "task";
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  status?: "ok" | "error";
  input?: string;
  output?: string;
}

// A small but varied set of spans across kinds, models, latencies, and one error.
const SAMPLES: SampleSpan[] = [
  {
    name: "support-agent.run",
    kind: "agent",
    durationMs: 4200,
    input: "Customer asks for a refund on order #8842",
    output: "Resolved: issued refund and sent confirmation email",
  },
  {
    name: "support-agent.plan",
    kind: "workflow",
    durationMs: 900,
    input: "Decide steps to resolve refund request",
    output: "1) look up order 2) check policy 3) issue refund",
  },
  {
    name: "openai.chat.completion",
    kind: "llm",
    model: "gpt-4o",
    provider: "openai",
    inputTokens: 1240,
    outputTokens: 320,
    durationMs: 2100,
    input: "Summarize the customer's refund eligibility",
    output: "The customer is eligible under the 30-day policy.",
  },
  {
    name: "anthropic.messages",
    kind: "llm",
    model: "claude-3-5-sonnet",
    provider: "anthropic",
    inputTokens: 2050,
    outputTokens: 540,
    durationMs: 3400,
    input: "Draft a polite refund confirmation",
    output: "Hi — your refund of $42.00 has been processed.",
  },
  {
    name: "lookup_order",
    kind: "tool",
    durationMs: 180,
    input: "{ orderId: '8842' }",
    output: "{ status: 'shipped', total: 42.0 }",
  },
  {
    name: "check_refund_policy",
    kind: "tool",
    durationMs: 95,
    input: "{ orderDate: '2026-06-01' }",
    output: "{ eligible: true, window: '30d' }",
  },
  {
    name: "research-agent.run",
    kind: "agent",
    durationMs: 8600,
    input: "Compile competitor pricing for Q2",
    output: "Built a 5-row comparison table",
  },
  {
    name: "openai.embeddings",
    kind: "task",
    model: "text-embedding-3-large",
    provider: "openai",
    inputTokens: 820,
    outputTokens: 0,
    durationMs: 240,
    input: "Embed 12 product descriptions",
    output: "12 vectors (3072 dims)",
  },
  {
    name: "openai.chat.completion",
    kind: "llm",
    model: "gpt-4o-mini",
    provider: "openai",
    inputTokens: 410,
    outputTokens: 70,
    durationMs: 5200,
    status: "error",
    input: "Classify ticket sentiment",
    output: "RateLimitError: provider returned 429",
  },
];

function randId(): string {
  // Decimal numeric string, matching the IDs Datadog's LLM Obs SDK emits.
  let s = "";
  for (let i = 0; i < 18; i++) s += Math.floor(Math.random() * 10);
  return s.replace(/^0+/, "") || "1";
}

async function main() {
  const url = `https://api.${SITE}/api/intake/llm-obs/v1/trace/spans`;
  const nowNs = Date.now() * 1_000_000;
  const traceId = randId();
  let parentId = "undefined";

  const spans = SAMPLES.map((s, i) => {
    const startNs = nowNs - (SAMPLES.length - i) * 60 * 1_000_000_000; // stagger ~1min apart
    const durationNs = Math.round(s.durationMs * 1_000_000);
    const inputTokens = s.inputTokens ?? 0;
    const outputTokens = s.outputTokens ?? 0;
    // LLM spans must carry IO as messages; other kinds use a plain value.
    const meta: Record<string, unknown> =
      s.kind === "llm"
        ? {
            kind: s.kind,
            input: { messages: [{ role: "user", content: s.input ?? "" }] },
            output: { messages: [{ role: "assistant", content: s.output ?? "" }] },
          }
        : {
            kind: s.kind,
            input: { value: s.input ?? "" },
            output: { value: s.output ?? "" },
          };
    if (s.model) meta.model_name = s.model;
    if (s.provider) meta.model_provider = s.provider;
    const span: Record<string, unknown> = {
      parent_id: parentId,
      trace_id: traceId,
      span_id: randId(),
      name: s.name,
      start_ns: startNs,
      duration: durationNs,
      status: s.status ?? "ok",
      meta,
      metrics: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
    // Chain everything under the first (root agent) span for a coherent trace.
    if (i === 0) parentId = String(span.span_id);
    return span;
  });

  const body = {
    data: {
      type: "span",
      attributes: {
        ml_app: ML_APP,
        tags: SAMPLE_TAGS,
        spans,
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "DD-API-KEY": API_KEY as string,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (res.status !== 202 && !res.ok) {
    console.error(`Datadog ingestion failed (HTTP ${res.status}): ${text}`);
    process.exit(1);
  }
  console.log(
    `Sent ${spans.length} sample spans to Datadog LLM Observability ` +
      `(ml_app="${ML_APP}", tag sample:true). HTTP ${res.status}.`,
  );
  console.log("They take ~30s to become searchable via the Export API.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
