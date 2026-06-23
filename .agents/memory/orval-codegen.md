---
name: Orval codegen quirk
description: Why prettier must stay disabled in the api-spec orval config
---

In this environment, running orval codegen with `prettier: true` hangs
indefinitely at the "Cleaning output folder" step and never produces output.

**Rule:** Keep `prettier: false` in `lib/api-spec/orval.config.ts`.

**Why:** With prettier enabled, codegen never completes, so the generated
client/zod files in `lib/api-client-react` and `lib/api-zod` never regenerate.
Disabling prettier makes codegen run cleanly; generated output is still valid
TypeScript, just not prettier-formatted.

**How to apply:** Any time you edit `lib/api-spec/openapi.yaml` and need to
regenerate hooks/zod schemas, ensure prettier stays disabled before running the
codegen command.
