# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/scripts run ingest` — ingest real usage from `scripts/data/` into the dashboard tables (idempotent; pass `-- --reset` for a clean full load)
- `pnpm --filter @workspace/scripts run seed` — DEV/FALLBACK ONLY: load synthetic sample data
- Required env: `DATABASE_URL` — Postgres connection string; optional `INGEST_DATA_DIR` — override the ingest source directory

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- DB schema (source of truth): `lib/db/src/schema/index.ts`
- API aggregation queries: `artifacts/api-server/src/routes/observability.ts` (costs derived from tokens × per-model pricing; never stored)
- Real data ingestion: `scripts/src/ingest.ts` ← reads `scripts/data/` (`models.json` pricing catalog, `directory.json` org/agent registry, `usage-log.ndjson` metered events)
- Synthetic dev data: `scripts/src/seed.ts`

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
