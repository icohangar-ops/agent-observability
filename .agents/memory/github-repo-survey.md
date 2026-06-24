---
name: Surveying icohangar-ops repos via GitHub API
description: How to reliably detect LLM/observability usage across the account's repos
---
- The GitHub **code search API** (`/search/code?q=user:icohangar-ops ...`) is unreliable for this account: its repos are freshly pushed and/or private, so they are largely **not indexed** — a sweep of LLM/obs terms returned only 1 hit despite ~15 repos clearly using LLM SDKs.
- **Authoritative approach:** fetch dependency manifests per repo via the contents API with `Accept: application/vnd.github.raw` (`/repos/icohangar-ops/<name>/contents/<file>?ref=<default_branch>`), choosing files by language (requirements.txt/pyproject.toml for Python, package.json for TS/JS, Cargo.toml for Rust, go.mod for Go), then regex for LLM SDKs and observability libs.
- **Caveat:** absence of a manifest hit ≠ no LLM. TS monorepos, subdir packages, or raw-HTTP LLM calls evade root-manifest detection (e.g. forge, vaultmind, agent-conductor read clean despite agent-heavy descriptions).
- **Finding (2026-06-24):** of ~85 repos, 15 had confirmed LLM SDK deps and **none** had any observability/OTel/Datadog instrumentation — a greenfield Datadog LLM Observability opportunity.
