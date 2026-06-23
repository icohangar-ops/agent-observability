---
name: Datadog LLM Observability API
description: Quirks of the LLM Obs Export (read) and ingestion (write) APIs used by the Traces feature
---

The Traces feature pulls agent/LLM spans from Datadog LLM Observability. Two
endpoints, with non-obvious payload rules discovered empirically against site us5.

## Export / search API (read)
`POST https://api.<DATADOG_SITE>/api/v2/llm-obs/v1/spans/events/search`
Headers: `DD-API-KEY` + `DD-APPLICATION-KEY`.

- Request `data.type` must be **`"spans"`** (NOT `"search_request"` — that 400s
  with `expected one of "spans"`).
- `filter.from` / `filter.to` must be **strings** — either epoch **milliseconds
  as a string** or a relative token like `"now-30d"` / `"now"`. Passing them as
  JSON numbers 400s with `error decoding attribute "filter.from": invalid type number`.
- Empty org (no LLM Obs index/data yet) returns **HTTP 500** with
  `{"errors":[{"detail":"No valid indexes specified"}]}`. This is "no traces
  yet", NOT a real error — map it to an empty-but-OK response.
- Response: `data[]` where each item is `{ id, type:"span", attributes:{...} }`.
  The span fields live directly on `attributes`: `span_kind` (the kind), `name`,
  `duration` (ns), `start_ns`, `status`, `model_name`, `model_provider`,
  `ml_app`, `tags` (string[]), and `metrics.{input_tokens,output_tokens,total_tokens}`.

## Ingestion API (write — sample data only)
`POST https://api.<DATADOG_SITE>/api/intake/llm-obs/v1/trace/spans`
Headers: **`DD-API-KEY` only** (no app key). Success = **HTTP 202**.

- Body: `data.type:"span"`, `data.attributes.{ml_app, tags, spans:[...]}`.
- Each span: `parent_id, trace_id, span_id` (decimal numeric strings),
  `name, start_ns, duration` (ns), `status`, `meta`, `metrics`.
- **kind=`llm` spans must carry IO as messages**: `meta.input={messages:[...]}`
  and `meta.output={messages:[...]}`. Using `{value:"..."}` for an llm span 400s
  with `llm spans can only have IO Messages, not value`. Non-llm kinds (agent,
  workflow, tool, task) DO use `{value:"..."}`.

**Why this matters:** the seed script (`scripts/src/seed-datadog-traces.ts`,
`pnpm --filter @workspace/scripts run seed:traces`) is the ONLY place AgentOps
writes to Datadog, and only sends clearly-labeled samples (ml_app
"agentops-samples", tag sample:true). The live dashboard path is read-only.
Ingested spans take ~30s to become searchable via the Export API.
