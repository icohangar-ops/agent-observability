---
name: API server routing & dev loop
description: Route mount paths and restart behavior for the api-server artifact
---

The `api-server` artifact's routers are mounted WITHOUT a per-feature prefix.
`app.ts` does `app.use("/api", router)` and `routes/index.ts` does
`router.use(observabilityRouter)` (no `/observability`). So observability routes
live directly under `/api` — e.g. `/api/employees`, `/api/models`, `/api/tiers`
— NOT `/api/observability/...`. Curl the bare `/api/<route>` when testing.

The dev script is `build && start` (esbuild bundle then `node dist`), with NO
watch. Code changes are NOT picked up until you restart the workflow. After
editing API routes, call `restart_workflow` on `artifacts/api-server: API Server`
before testing.

**How to apply:** Test API endpoints at `localhost:8080/api/<route>` after a
workflow restart; the dev domain `/api` does not proxy to this server.
