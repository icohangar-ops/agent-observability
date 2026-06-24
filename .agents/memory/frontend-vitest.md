---
name: Frontend vitest setup (agent-observability)
description: How frontend component tests are wired in the agent-observability artifact
---

The `agent-observability` artifact tests components with **vitest@3 + jsdom +
@testing-library/react** (NOT node:test — that's only the api-server). Config is
`vitest.config.ts` (own file, separate from `vite.config.ts` which requires
PORT/BASE_PATH env and would crash test runs). Setup file
`src/test/setup.ts` imports `@testing-library/jest-dom/vitest` and runs
`cleanup()` afterEach. Run with `pnpm --filter @workspace/agent-observability test`.

**Patterns that work:**
- Mock the API hooks: `vi.mock("@workspace/api-client-react", () => ({ useListTraces: ... }))`
  returning `{ data, isLoading }` shaped objects.
- Mock `@/lib/date-range` so `useDateRange()` returns `{ params: undefined, ... }`
  (avoids needing a DateRangeProvider wrapper).
- Mock `wouter`'s `useLocation` to `["/path", vi.fn()]`.
- The shadcn `Skeleton` component has NO `data-slot`; assert loading via
  `container.querySelector(".animate-pulse")`.

**Why vitest@3 not @2:** vite is on v7 here; vitest@2 (2.1.9) also hit a package
firewall 403. vitest@3 installs fine and matches vite 7.
