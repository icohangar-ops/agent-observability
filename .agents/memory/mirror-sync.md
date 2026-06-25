---
name: GitHub/Codeberg mirror sync
description: How main is mirrored to GitHub + Codeberg after merges, and the Codeberg 504 quirk
---

The post-merge script pushes `main` to two read-only mirrors (GitHub
`icohangar-ops/agent-observability`, Codeberg `cubiczan/agent-observability`)
via a dedicated helper script. Credentials come from the `GITHUB_PAT` /
`CODEBERG_PAT` secrets and are fed to git through an inline
`-c credential.helper` (a `!f(){...}` shell snippet) — never via the URL or
`.git/config`, because the main environment blocks `git remote add`.

**Why retries + generous timeout:** Codeberg's git-over-HTTPS endpoint
intermittently returns HTTP 504 (gateway timeout) from this environment,
failing in ~30s regardless of client timeout. It almost always succeeds on a
retry. So the helper retries each mirror (default 3 attempts with back-off),
and the post-merge timeout must stay generous (raised to ~240s) or the merge
setup can be killed mid-sync.

**How to apply:** A failed mirror push is best-effort — post-merge does not
hard-fail on it. Check the per-mirror status log to confirm the last sync. If
Codeberg shows FAIL, it is usually a transient 504; re-running the sync fixes
it. Knobs: `MIRROR_MAX_ATTEMPTS`, `MIRROR_RETRY_SLEEP`, `MIRROR_PUSH_TIMEOUT`.

**Distinguishing a 504 from a stale token:** if *all* Codeberg attempts fail
consistently across separate runs (not just one flaky run), suspect an expired
`CODEBERG_PAT`, not a 504. Diagnose by pushing once with verbose git output and
a fresh token via the inline credential helper (don't suppress stderr) — a 504
shows a gateway error, an expired token shows auth failure. Fix is to rotate the
`CODEBERG_PAT` secret (request it; secrets can't be set directly).
