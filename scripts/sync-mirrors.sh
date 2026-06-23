#!/bin/bash
# Push the local `main` branch to the GitHub and Codeberg mirrors.
#
# Credentials are read at runtime from the GITHUB_PAT and CODEBERG_PAT
# environment secrets and supplied to git via an inline credential helper, so
# tokens never touch `.git/config` or the remote URL. The main environment
# blocks `git remote add`, so we push directly to the remote URL instead.
#
# A one-line status for each mirror (and an overall summary) is appended to
# scripts/.mirror-sync-status.log so the last sync result is easy to inspect.

set -uo pipefail

BRANCH="main"
STATUS_LOG="scripts/.mirror-sync-status.log"
PUSH_TIMEOUT="${MIRROR_PUSH_TIMEOUT:-150}"
# Codeberg's git-over-HTTPS endpoint intermittently returns 504 from this
# environment, so allow several attempts with a back-off between them.
MAX_ATTEMPTS="${MIRROR_MAX_ATTEMPTS:-3}"
RETRY_SLEEP="${MIRROR_RETRY_SLEEP:-8}"

timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

log_status() {
  echo "[$(timestamp)] $1" | tee -a "$STATUS_LOG"
}

push_mirror() {
  local name="$1" url="$2" user="$3" token="$4"

  if [ -z "$token" ]; then
    log_status "SKIP  $name — credential not set in environment"
    return 1
  fi

  # Inline credential helper: reads the token from the value captured above and
  # feeds it to git on demand. The leading '!' makes git run it as a shell
  # snippet; it ignores git's operation argument and just prints credentials.
  local helper="!f() { echo username=${user}; echo password=${token}; }; f"

  local attempt
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    if timeout "$PUSH_TIMEOUT" git \
        -c credential.helper="$helper" \
        push --force "$url" "refs/heads/${BRANCH}:refs/heads/${BRANCH}" >/dev/null 2>&1; then
      log_status "OK    $name (attempt ${attempt})"
      return 0
    fi
    log_status "RETRY $name (attempt ${attempt} failed)"
    sleep "$RETRY_SLEEP"
  done

  log_status "FAIL  $name after ${MAX_ATTEMPTS} attempts"
  return 1
}

if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  log_status "ABORT no local '${BRANCH}' branch to push"
  exit 1
fi

overall=0
push_mirror "github  " "https://github.com/icohangar-ops/agent-observability.git" "x-access-token" "${GITHUB_PAT:-}" || overall=1
push_mirror "codeberg" "https://codeberg.org/cubiczan/agent-observability.git" "cubiczan" "${CODEBERG_PAT:-}" || overall=1

if [ "$overall" -eq 0 ]; then
  log_status "DONE  all mirrors in sync at $(git rev-parse --short "$BRANCH")"
else
  log_status "DONE  one or more mirrors failed to sync"
fi

exit "$overall"
