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
- `metrics.estimated_total_cost` (also input/output cost breakdowns) is reported
  in **micro-dollars** — divide by 1_000_000 for USD. This is Datadog's own
  estimate and is independent of the per-model pricing the rest of the app uses,
  so surface it labeled as a "Datadog estimate".

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
- **Datadog lowercases tag VALUES** on ingest: a `department:Finance` tag comes
  back as `department:finance`. The breakdown's `departmentOf` checks tags BEFORE
  the ml_app→DB mapping, so a department tag wins and yields ugly lowercase
  names. For demo attribution, set each span batch's `ml_app` to a **real agent
  id** (from `scripts/data/directory.json`) and add NO department tag — the
  breakdown resolves the proper-cased department name from the DB (agents →
  employees → departments). One ingestion POST per ml_app (ml_app + tags are
  batch-level, not per-span).
- `metrics.estimated_total_cost` must be set (in **micro-dollars**) on cost-
  bearing spans or the breakdown bars are all $0. Seed computes it from tokens ×
  a per-model rate table.
- Datadog can't delete ingested spans; mistakes (e.g. a wrong/lowercase tag
  during testing) linger until they age out of the query window (~30d).

**Why this matters:** the seed script (`scripts/src/seed-datadog-traces.ts`,
`pnpm --filter @workspace/scripts run seed:traces`) is the ONLY place AgentOps
writes to Datadog, and only sends clearly-labeled samples (tag sample:true,
env:demo), one batch per real agent id as ml_app so the department breakdown is
populated. The live dashboard path is read-only. Ingested spans take ~30s to
become searchable via the Export API.
