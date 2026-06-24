/**
 * Seed clearly-labeled sample agent traces into Datadog LLM Observability.
 *
 * The connected Datadog org has no real LLM Obs data, so this sends a handful of
 * synthetic agent/LLM spans to the LLM Observability ingestion API. The
 * dashboard's Traces page then has real data to read back through the Export API.
 *
 * Each sample run is attributed to a REAL agent id from the directory: the run's
 * ml_app is the agent id, which the breakdown route maps to its owning department
 * via agents → employees → departments. We deliberately do NOT add a
 * `department:<name>` tag — Datadog lowercases tag values and the breakdown
 * prefers a department tag over the DB mapping, so a tag would override (and
 * uglify) the proper-cased directory name. LLM spans carry an
 * estimated_total_cost so the "Top departments by est. cost" card shows a varied,
 * realistic split instead of one big "(unattributed)" bucket.
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

// One realistic agent run, attributed to a real agent id (used as ml_app) whose
// owning department the breakdown route resolves via the directory. The
// `department` here is only documentation / log output — it is NOT sent as a tag.
interface SampleRun {
  /** Real agent id from scripts/data/directory.json — becomes the run's ml_app. */
  agentId: string;
  /** Expected owning department (for documentation and seed log output only). */
  department: string;
  spans: SampleSpan[];
}

// Approximate USD price per 1K tokens (input / output) by model, used to attach a
// realistic estimated_total_cost to LLM/embedding spans. Unknown models fall back
// to a small default so a cost is always present.
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 0.005, out: 0.015 },
  "gpt-4o-mini": { in: 0.00015, out: 0.0006 },
  "claude-3-5-sonnet": { in: 0.003, out: 0.015 },
  "claude-3-haiku": { in: 0.00025, out: 0.00125 },
  "gemini-1-5-pro": { in: 0.00125, out: 0.005 },
  "llama-3-1-70b": { in: 0.0009, out: 0.0009 },
  "openrouter-auto": { in: 0.002, out: 0.006 },
  "perplexity-sonar-large": { in: 0.001, out: 0.001 },
  "baseten-router": { in: 0.0005, out: 0.0015 },
  "text-embedding-3-large": { in: 0.00013, out: 0 },
};

// Estimated cost in micro-dollars (the unit Datadog reports estimated_total_cost
// in, and what the dashboard divides by 1e6). Non-token spans cost nothing.
function estimatedCostMicros(s: SampleSpan): number {
  if (!s.model) return 0;
  const price = MODEL_PRICING[s.model] ?? { in: 0.001, out: 0.002 };
  const inTok = s.inputTokens ?? 0;
  const outTok = s.outputTokens ?? 0;
  const usd = (inTok / 1000) * price.in + (outTok / 1000) * price.out;
  return Math.round(usd * 1_000_000);
}

// A varied set of runs spanning eight departments, each tied to a real agent id
// so the department breakdown shows multiple non-zero departments. Costs differ
// by model and token volume so the split looks realistic, not uniform.
const RUNS: SampleRun[] = [
  {
    agentId: "agent-36", // Ticket Classifier — Customer Support
    department: "Customer Support",
    spans: [
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
        model: "gpt-4o-mini",
        provider: "openai",
        inputTokens: 1240,
        outputTokens: 320,
        durationMs: 2100,
        input: "Summarize the customer's refund eligibility",
        output: "The customer is eligible under the 30-day policy.",
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
    ],
  },
  {
    agentId: "agent-1", // Log Analyzer — Engineering
    department: "Engineering",
    spans: [
      {
        name: "log-analyzer.run",
        kind: "agent",
        durationMs: 6100,
        input: "Investigate the spike in 5xx errors over the last hour",
        output: "Root cause: a bad deploy of the checkout service at 14:05",
      },
      {
        name: "gemini.generate",
        kind: "llm",
        model: "gemini-1-5-pro",
        provider: "google",
        inputTokens: 3200,
        outputTokens: 600,
        durationMs: 3300,
        input: "Correlate the attached error logs and find the root cause",
        output: "Errors cluster around checkout-service v2.4.1; recommend rollback.",
      },
      {
        name: "parse_logs",
        kind: "tool",
        durationMs: 220,
        input: "{ window: '1h', service: 'checkout' }",
        output: "{ matches: 1843, topError: 'NullPointer' }",
      },
    ],
  },
  {
    agentId: "agent-18", // Email Outreach Agent — Sales
    department: "Sales",
    spans: [
      {
        name: "outreach-agent.run",
        kind: "agent",
        durationMs: 3800,
        input: "Draft a follow-up email to a warm lead at Acme Corp",
        output: "Sent a personalized follow-up referencing their Q2 expansion",
      },
      {
        name: "openai.chat.completion",
        kind: "llm",
        model: "gpt-4o-mini",
        provider: "openai",
        inputTokens: 900,
        outputTokens: 250,
        durationMs: 1700,
        input: "Write a concise, friendly follow-up email",
        output: "Hi Jordan — circling back on our chat about scaling your team...",
      },
      {
        name: "crm_lookup",
        kind: "tool",
        durationMs: 140,
        input: "{ account: 'Acme Corp' }",
        output: "{ stage: 'evaluation', owner: 'Noah Fischer' }",
      },
    ],
  },
  {
    agentId: "agent-27", // Campaign Analyzer — Marketing
    department: "Marketing",
    spans: [
      {
        name: "campaign-agent.run",
        kind: "agent",
        durationMs: 5400,
        input: "Analyze last week's paid campaign performance",
        output: "CTR up 12%; recommend shifting budget to the retargeting set",
      },
      {
        name: "llama.chat",
        kind: "llm",
        model: "llama-3-1-70b",
        provider: "meta",
        inputTokens: 2600,
        outputTokens: 720,
        durationMs: 2900,
        input: "Summarize campaign metrics and suggest reallocations",
        output: "Retargeting delivers the best ROAS; scale it 20%.",
      },
    ],
  },
  {
    agentId: "agent-54", // Report Compiler — Finance
    department: "Finance",
    spans: [
      {
        name: "report-agent.run",
        kind: "agent",
        durationMs: 9200,
        input: "Compile the Q2 spend report by department",
        output: "Generated an 8-section report with variance commentary",
      },
      {
        name: "anthropic.messages",
        kind: "llm",
        model: "claude-3-5-sonnet",
        provider: "anthropic",
        inputTokens: 4100,
        outputTokens: 1100,
        durationMs: 4600,
        input: "Write variance commentary for each department's Q2 spend",
        output: "Engineering came in 6% under budget driven by lower cloud spend...",
      },
      {
        name: "fetch_spend",
        kind: "tool",
        durationMs: 260,
        input: "{ quarter: 'Q2', groupBy: 'department' }",
        output: "{ rows: 8, total: 412900 }",
      },
    ],
  },
  {
    agentId: "agent-62", // User Interview Analyzer — Product
    department: "Product",
    spans: [
      {
        name: "interview-agent.run",
        kind: "agent",
        durationMs: 7300,
        input: "Synthesize themes from 12 user interviews",
        output: "Surfaced 4 recurring themes; onboarding friction is top",
      },
      {
        name: "openai.chat.completion",
        kind: "llm",
        model: "gpt-4o-mini",
        provider: "openai",
        inputTokens: 5200,
        outputTokens: 900,
        durationMs: 4100,
        input: "Cluster interview transcripts into themes",
        output: "Themes: onboarding friction, pricing confusion, mobile parity...",
      },
      {
        name: "openai.embeddings",
        kind: "task",
        model: "text-embedding-3-large",
        provider: "openai",
        inputTokens: 820,
        outputTokens: 0,
        durationMs: 240,
        input: "Embed 12 interview transcripts",
        output: "12 vectors (3072 dims)",
      },
    ],
  },
  {
    agentId: "agent-79", // NDA Drafter — Legal
    department: "Legal",
    spans: [
      {
        name: "nda-agent.run",
        kind: "agent",
        durationMs: 8600,
        input: "Draft a mutual NDA for a new vendor engagement",
        output: "Produced a redlined mutual NDA from the standard template",
      },
      {
        name: "openai.chat.completion",
        kind: "llm",
        model: "gpt-4o",
        provider: "openai",
        inputTokens: 3000,
        outputTokens: 1400,
        durationMs: 5200,
        input: "Draft a mutual NDA tailored to a SaaS vendor",
        output: "MUTUAL NON-DISCLOSURE AGREEMENT. This Agreement is entered into...",
      },
      {
        name: "openai.chat.completion",
        kind: "llm",
        model: "gpt-4o",
        provider: "openai",
        inputTokens: 410,
        outputTokens: 70,
        durationMs: 5200,
        status: "error",
        input: "Classify the NDA's risk level",
        output: "RateLimitError: provider returned 429",
      },
    ],
  },
  {
    agentId: "agent-71", // Vendor Researcher — Operations
    department: "Operations",
    spans: [
      {
        name: "vendor-agent.run",
        kind: "agent",
        durationMs: 6700,
        input: "Research three logistics vendors and compare SLAs",
        output: "Built a comparison of pricing, coverage, and SLA terms",
      },
      {
        name: "openrouter.chat",
        kind: "llm",
        model: "openrouter-auto",
        provider: "openrouter",
        inputTokens: 1800,
        outputTokens: 520,
        durationMs: 3100,
        input: "Compare the three vendors' SLAs and flag risks",
        output: "Vendor B offers the strongest SLA but the highest price.",
      },
      {
        name: "web_search",
        kind: "tool",
        durationMs: 480,
        input: "{ query: 'logistics vendor SLA comparison' }",
        output: "{ results: 9 }",
      },
    ],
  },
];

function randId(): string {
  // Decimal numeric string, matching the IDs Datadog's LLM Obs SDK emits.
  let s = "";
  for (let i = 0; i < 18; i++) s += Math.floor(Math.random() * 10);
  return s.replace(/^0+/, "") || "1";
}

// Build the ingestion payload for a single run: one trace whose spans all chain
// under the root agent span, attributed to the run's agent id (ml_app) and tagged
// with its department.
function buildRunBody(run: SampleRun, runIndex: number, runCount: number) {
  const nowNs = Date.now() * 1_000_000;
  const traceId = randId();
  let parentId = "undefined";

  const spans = run.spans.map((s, i) => {
    // Stagger runs roughly an hour apart and spans within a run a few seconds
    // apart so the waterfall and timestamps look natural.
    const runOffsetNs = (runCount - runIndex) * 60 * 60 * 1_000_000_000;
    const spanOffsetNs = (run.spans.length - i) * 5 * 1_000_000_000;
    const startNs = nowNs - runOffsetNs - spanOffsetNs;
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
        estimated_total_cost: estimatedCostMicros(s),
      },
    };
    // Chain everything under the first (root agent) span for a coherent trace.
    if (i === 0) parentId = String(span.span_id);
    return span;
  });

  return {
    data: {
      type: "span",
      attributes: {
        // ml_app is the real agent id; the breakdown route resolves it to the
        // owning department via the directory (agents → employees →
        // departments), yielding properly-cased names. We deliberately do NOT
        // add a department:<name> tag — Datadog lowercases tag values, and that
        // tag would win over (and uglify) the DB-derived department name.
        ml_app: run.agentId,
        tags: SAMPLE_TAGS,
        spans,
      },
    },
  };
}

async function sendRun(run: SampleRun, body: unknown): Promise<number> {
  const url = `https://api.${SITE}/api/intake/llm-obs/v1/trace/spans`;
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
    console.error(
      `Datadog ingestion failed for agent ${run.agentId} (HTTP ${res.status}): ${text}`,
    );
    process.exit(1);
  }
  return res.status;
}

async function main() {
  let totalSpans = 0;
  for (let i = 0; i < RUNS.length; i++) {
    const run = RUNS[i];
    const body = buildRunBody(run, i, RUNS.length);
    const status = await sendRun(run, body);
    totalSpans += run.spans.length;
    console.log(
      `Sent ${run.spans.length} spans for ml_app="${run.agentId}" ` +
        `(department:${run.department}). HTTP ${status}.`,
    );
  }
  console.log(
    `Done: ${totalSpans} sample spans across ${RUNS.length} departments ` +
      `(tag sample:true). They take ~30s to become searchable via the Export API.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
