/**
 * Datadog LLM Observability client.
 *
 * Read-only pull of agent/LLM execution spans from Datadog's LLM Observability
 * Export API (POST /api/v2/llm-obs/v1/spans/events/search). Credentials live on
 * the server only and are never sent to the browser.
 *
 * When an org has no LLM Observability data the Export API responds with HTTP
 * 500 `{"errors":[{"detail":"No valid indexes specified"}]}`. That is not a real
 * failure for us — it just means "no traces yet" — so `searchSpans` maps it to an
 * empty result with `noData: true` rather than throwing.
 */
import { logger } from "./logger";

export interface NormalizedSpan {
  spanId: string;
  traceId: string;
  parentId: string | null;
  name: string;
  kind: string;
  model: string | null;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Datadog-estimated total cost for the span, in USD. */
  estimatedCostUsd: number;
  latencyMs: number;
  status: string;
  timestamp: string;
  mlApp: string | null;
  tags: string[];
  /** Human-readable span input, flattened from Datadog's meta.input. */
  input: string | null;
  /** Human-readable span output, flattened from Datadog's meta.output. */
  output: string | null;
}

export interface SearchSpansResult {
  spans: NormalizedSpan[];
  /** True when Datadog has no LLM Obs index/data yet (empty-but-OK). */
  noData: boolean;
}

export interface SearchSpansOptions {
  /** Inclusive start as epoch milliseconds, or a relative string like "now-30d". */
  from: number | string;
  /** Exclusive/relative end as epoch milliseconds, or a string like "now". */
  to: number | string;
  /** Datadog LLM Obs query string. Empty matches all spans. */
  query?: string;
  limit?: number;
}

interface DatadogConfig {
  site: string;
  apiKey: string;
  appKey: string;
}

function readConfig(): DatadogConfig {
  const site = process.env.DATADOG_SITE;
  const apiKey = process.env.DATADOG_API_KEY;
  const appKey = process.env.DATADOG_APP_KEY;
  if (!site || !apiKey || !appKey) {
    throw new Error(
      "Datadog is not configured: DATADOG_SITE, DATADOG_API_KEY and DATADOG_APP_KEY must all be set.",
    );
  }
  return { site, apiKey, appKey };
}

export function isDatadogConfigured(): boolean {
  return Boolean(
    process.env.DATADOG_SITE && process.env.DATADOG_API_KEY && process.env.DATADOG_APP_KEY,
  );
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

// Flatten a Datadog LLM Obs meta.input / meta.output value into readable text.
// Non-llm spans carry `{ value: "..." }`; llm spans carry `{ messages: [...] }`.
// Anything else is JSON-serialized so nothing is silently dropped.
function flattenIO(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v !== "" ? v : null;
  if (typeof v !== "object") return String(v);
  const obj = v as Record<string, unknown>;
  if (typeof obj.value === "string") return obj.value !== "" ? obj.value : null;
  if (Array.isArray(obj.messages)) {
    const parts = obj.messages
      .map((m) => {
        if (m && typeof m === "object") {
          const msg = m as Record<string, unknown>;
          const role = typeof msg.role === "string" && msg.role !== "" ? msg.role : null;
          const content = msg.content;
          const text =
            typeof content === "string"
              ? content
              : content != null
                ? JSON.stringify(content)
                : "";
          if (text === "") return "";
          // Preserve the role label (e.g. "system:", "user:") so the flattened
          // text stays legible when several messages are joined together.
          return role ? `${role}: ${text}` : text;
        }
        return typeof m === "string" ? m : JSON.stringify(m);
      })
      .filter((s) => typeof s === "string" && s !== "");
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

// Map a raw Datadog LLM Obs span event (the `attributes` object of a search hit)
// into the flat shape the dashboard consumes.
function normalizeSpan(id: string, attrs: Record<string, unknown>): NormalizedSpan {
  const metrics = (attrs.metrics ?? {}) as Record<string, unknown>;
  const startNs = num(attrs.start_ns);
  const durationNs = num(attrs.duration);
  const inputTokens = num(metrics.input_tokens);
  const outputTokens = num(metrics.output_tokens);
  const totalTokens = metrics.total_tokens != null ? num(metrics.total_tokens) : inputTokens + outputTokens;
  // Datadog reports estimated cost in micro-dollars; convert to USD.
  const estimatedCostUsd = num(metrics.estimated_total_cost) / 1_000_000;
  const rawTags = Array.isArray(attrs.tags) ? (attrs.tags as unknown[]) : [];
  const meta = (attrs.meta ?? {}) as Record<string, unknown>;
  return {
    spanId: str(attrs.span_id) ?? id,
    traceId: str(attrs.trace_id) ?? "",
    parentId: str(attrs.parent_id),
    name: str(attrs.name) ?? "(unnamed span)",
    kind: str(attrs.span_kind) ?? "unknown",
    model: str(attrs.model_name),
    provider: str(attrs.model_provider),
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd,
    latencyMs: durationNs / 1_000_000,
    status: str(attrs.status) ?? "ok",
    timestamp: startNs > 0 ? new Date(startNs / 1_000_000).toISOString() : new Date(0).toISOString(),
    mlApp: str(attrs.ml_app),
    tags: rawTags.filter((t): t is string => typeof t === "string"),
    input: flattenIO(meta.input ?? attrs.input),
    output: flattenIO(meta.output ?? attrs.output),
  };
}

function isNoIndexError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const detail = (e as { detail?: unknown })?.detail;
    return typeof detail === "string" && detail.toLowerCase().includes("no valid indexes");
  });
}

/**
 * Search agent/LLM spans from Datadog's LLM Observability Export API.
 * Returns `{ noData: true }` (empty) when the org has no LLM Obs data yet.
 */
export async function searchSpans(opts: SearchSpansOptions): Promise<SearchSpansResult> {
  const { site, apiKey, appKey } = readConfig();
  const url = `https://api.${site}/api/v2/llm-obs/v1/spans/events/search`;
  const body = {
    data: {
      type: "spans",
      attributes: {
        filter: {
          // Datadog's Export API requires from/to as strings (epoch millis as a
          // string, or a relative token like "now-30d") — numbers are rejected.
          from: String(opts.from),
          to: String(opts.to),
          query: opts.query ?? "",
        },
        page: { limit: opts.limit ?? 1000 },
        sort: "-timestamp",
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "DD-API-KEY": apiKey,
      "DD-APPLICATION-KEY": appKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    // Empty org / no LLM Obs index yet — treat as "no traces", not an error.
    if (res.status === 500 && isNoIndexError(parsed)) {
      return { spans: [], noData: true };
    }
    logger.error({ status: res.status, body: text.slice(0, 500) }, "Datadog spans search failed");
    throw new Error(`Datadog spans search failed with status ${res.status}`);
  }

  const data = (parsed as { data?: unknown })?.data;
  const items = Array.isArray(data) ? data : [];
  const spans = items.map((item) => {
    const it = item as { id?: unknown; attributes?: unknown };
    const attrs = (it.attributes ?? {}) as Record<string, unknown>;
    return normalizeSpan(String(it.id ?? ""), attrs);
  });
  return { spans, noData: false };
}
