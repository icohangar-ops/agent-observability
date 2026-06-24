---
name: Real-SQL tests against Postgres
description: How to faithfully test actual SQL (date windows, aggregates) in api-server when the main suite stubs the pool.
---
The observability.test.ts suite replaces `pool.query` with an in-memory dispatcher,
so any SQL logic (date windows, math, aggregation) is never really executed — it
returns hardcoded rows. To test the genuine SQL behavior:

- Make the route helper accept an injectable query executor (a minimal
  `{ query(text, params) }` structural type) defaulting to the shared `pool`, and
  export it. This keeps the exact same SQL while letting a test pass its own client.
- In a separate `*.test.ts` file, import the real `pool` from `@workspace/db`,
  `pool.connect()` a client, run everything in `BEGIN` ... `ROLLBACK` (per test),
  and create `CREATE TEMP TABLE ... ON COMMIT DROP` tables that mirror only the
  columns the query reads. Temp tables live in pg_temp (first on search_path), so
  unqualified table names in the real query resolve to them. Rollback also drops
  them — zero pollution.
- Compute boundary timestamps in SQL (`date_trunc('month', now())` etc.), not JS,
  to avoid client/server timezone drift.

**Why:** an off-by-one in a SQL date boundary is invisible to the stubbed suite.
**How to apply:** each test bundle is esbuild-bundled separately, so its `pool` is
independent of the stubbed one. Requires a live DATABASE_URL (present in this env).
`pool.connect()`'s TS overload resolves to `void`, so cast the client through
`unknown` to your structural type. End the pool in `after()` so the process exits.
