---
name: api-client dist staleness vs typecheck
description: Why artifact typecheck fails on "no exported member" from @workspace/api-client-react and how to fix
---

Artifact `typecheck` (tsc project references) resolves `@workspace/api-client-react`
to its built `dist/*.d.ts`, NOT `src`. Vitest/runtime resolve to `src/index.ts`
(the package `exports` map). So a stale `dist` makes tsc report
`has no exported member 'useListTraces' / 'TraceSpan' / ...` while tests still
pass at runtime.

**Why:** The generated client `dist` is committed but can lag behind `src` after
spec changes. tsc trusts `dist`; vitest trusts `src`. The mismatch surfaces as
phantom "missing export" errors across many artifact pages at once.

**How to apply:** When artifact typecheck fails with `no exported member` from a
`@workspace/*` generated client (and the symbol clearly exists in its `src`),
regenerate before touching page code:
`pnpm --filter @workspace/api-spec run codegen` (runs orval + `typecheck:libs`
which rebuilds the lib `dist`). This alone can clear a whole batch of page-level
type errors that look like real bugs but are just a stale client.
