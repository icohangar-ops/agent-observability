---
name: Orval codegen quirk
description: How to regenerate the api-spec client/zod reliably in this env
---

In this environment, running orval codegen with `prettier: true` hangs
indefinitely at the "Cleaning output folder" step and never produces output.

Even with `prettier: false`, the run is slow: it can sit at
"api-client-react Cleaning output folder" for ~90-115s with no further output
before completing successfully (exit 0). Do NOT assume it has hung and kill it
early — give it a single uninterrupted run of at least ~2 minutes. Run the
binary directly (`node node_modules/orval/dist/bin/orval.mjs`) so a wrapper
timeout doesn't cut it off mid-generation.

**Rule:** Keep `prettier: false` in `lib/api-spec/orval.config.ts`.

**Why:** With prettier enabled, codegen never completes, so the generated
client/zod files in `lib/api-client-react` and `lib/api-zod` never regenerate.
Disabling prettier makes codegen run cleanly; generated output is still valid
TypeScript, just not prettier-formatted.

**How to apply:** Any time you edit `lib/api-spec/openapi.yaml` and need to
regenerate hooks/zod schemas, ensure prettier stays disabled before running the
codegen command.

## Codegen runtime + two-step regen (important)

- orval takes ~100s for this spec. It MUST run synchronously inside ONE bash
  call with the full ~120s timeout. Background/nohup processes get killed when
  a bash tool call returns, and because the configs use `clean: true`, a killed
  run leaves the generated files DELETED (breaks the build). Never background it.
- `clean: true` deletes outputs first, then regenerates — so a partial run is
  worse than no run.
- After orval, you MUST run `pnpm run typecheck:libs` (which is `tsc --build`).
  The lib packages are TypeScript project references with composite output, so
  consuming artifacts resolve `@workspace/api-client-react` types from the
  emitted declaration outputs, NOT from `src/generated`. If you skip this, the
  artifact's `tsc` reports "Property X does not exist" / "no exported member"
  even though the new fields ARE present in `src/generated`. The full `codegen`
  script already chains both (`orval && pnpm -w run typecheck:libs`); if you run
  orval alone, run typecheck:libs yourself afterward.

**Also:** codegen can also hang at "Cleaning output folder" even with prettier
off. Workaround: temporarily set `clean: false` in `orval.config.ts`, manually
`rm -rf` the generated dirs, run `pnpm exec orval`, then restore `clean: true`.

**Env quirk:** long-running commands (orval, `tsc --noEmit`, `typecheck:libs`)
get killed by the bash tool wrapper on return (exit -1/124). Verify code via the
running web/API workflows + curl/screenshots instead of relying on standalone tsc.

## api-zod barrel name collision when an endpoint gets BOTH path + query params

- Adding query params (e.g. `from`/`to`) to an endpoint that already has a path
  param makes orval's zod generator emit a `<Op>Params` VALUE (the path-param
  schema) in `lib/api-zod/src/generated/api.ts` AND a same-named TS TYPE (the
  query-param shape) in `lib/api-zod/src/generated/types/`. The hand-written
  barrel `lib/api-zod/src/index.ts` re-exports both folders with `export *`, so
  `typecheck:libs` then fails with TS2308 "already exported a member named
  `<Op>Params`".
- **Fix:** in `lib/api-zod/src/index.ts`, after the two `export *` lines, add an
  explicit `export { <Op>Params, ... } from "./generated/api";` for each colliding
  op to disambiguate (the zod schema value wins; the redundant query-param type is
  shadowed). The barrel is hand-maintained, not generated, so this survives regen.
- **Why:** query-only endpoints don't collide because their zod schema is named
  `<Op>QueryParams` while the type is `<Op>Params`. Only the path+query combo
  produces two symbols sharing the exact name `<Op>Params`.
