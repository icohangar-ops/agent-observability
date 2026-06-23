#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

# Mirror the freshly-merged `main` to the GitHub and Codeberg copies. A mirror
# failure (e.g. a slow Codeberg endpoint) should not fail the whole merge setup,
# so this runs best-effort; check scripts/.mirror-sync-status.log for results.
bash scripts/sync-mirrors.sh || echo "mirror sync reported a failure; see scripts/.mirror-sync-status.log"
