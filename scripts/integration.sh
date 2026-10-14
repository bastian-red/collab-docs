#!/usr/bin/env bash
#
# The integration lane: real Postgres, real Redis, and TWO real sync replicas.
#
# Two, not one, and that is the point. Every claim this project makes about
# horizontal scaling is a claim about the Redis relay, and a single replica
# cannot exercise it: two clients on one process converge through the shared
# in-memory Y.Doc whether the relay works or not. Remove the Redis extension
# from apps/sync and the one-replica version of this suite stays green.
#
# The API runs here too, in its own suite. Its subject is different -- the module
# graph, the guards, the transactions -- but it needs the same Postgres, the same
# Redis and the same seed, and standing a second lane up beside this one would
# mean two scripts that must be kept in step about how the database is prepared.
#
#   ./scripts/integration.sh              # everything, both suites
#   ./scripts/integration.sh convergence  # one sync file, by name
#   ./scripts/integration.sh --api        # the API suite alone
#
# The replicas are started from the SAME entry point `pnpm dev` uses, with
# nothing but PORT differing, because a lane that runs the app differently from
# the way it is documented tests a program nobody else runs.
set -euo pipefail

cd "$(dirname "$0")/.."

# Caller env > .env > .env.example (scripts/load-env.sh says why).
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

export DATABASE_URL="${DATABASE_URL:-postgresql://collab:collab@localhost:5440/collab?schema=public}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6386}"
export SYNC_BASE_URL="${SYNC_BASE_URL:-http://localhost:4100}"
export SYNC_BASE_URL_2="${SYNC_BASE_URL_2:-http://localhost:4101}"

# Both apps import workspace packages through their dist/ (the sync replicas run
# under tsx, the API suite under vitest), and a CI checkout has none: the second
# CI run died with ERR_MODULE_NOT_FOUND on @docs/doc-access. A local run that
# had already built them hid it. Turbo makes this a cache hit when nothing changed.
pnpm exec turbo run build --filter=@docs/sync^... --filter=@docs/api^... --output-logs=errors-only >/dev/null

if [[ -z "${AUTH_SECRET:-}" ]]; then
  echo "AUTH_SECRET is not set. The sync server refuses to boot without it, and every" >&2
  echo "handshake would fail with a signature error that looks like a broken test." >&2
  exit 1
fi

# Compaction and version thresholds are LOW here on purpose. The defaults (200
# updates, 300 seconds) would mean the compaction and version-cadence tests could
# only be exercised by typing two hundred paragraphs or by sleeping five minutes,
# so the lane would quietly stop covering them.
export COMPACT_AFTER_UPDATES="${INTEGRATION_COMPACT_AFTER_UPDATES:-3}"
export COMPACT_AFTER_SECONDS="${INTEGRATION_COMPACT_AFTER_SECONDS:-1}"
export VERSION_INTERVAL_SECONDS="${INTEGRATION_VERSION_INTERVAL_SECONDS:-1}"
export STORE_DEBOUNCE_MS="${INTEGRATION_STORE_DEBOUNCE_MS:-200}"
export STORE_MAX_DEBOUNCE_MS="${INTEGRATION_STORE_MAX_DEBOUNCE_MS:-400}"

# The API's own knobs. The rate limits are lifted well above the documented
# defaults ON PURPOSE: this suite makes a few hundred requests from one address in
# under a minute, and the auth budget of 5/min exists to stop credential stuffing,
# not to stop a test run. Nothing here asserts a 429 -- spending a live budget to
# prove a limit works would leave every later test in the file rate-limited. What
# the limits are checked against instead is `assertConsistent`, which refuses to
# boot when the auth budget is not below the general one, and that has its own
# gate test.
export RATE_LIMIT_GLOBAL="${INTEGRATION_RATE_LIMIT_GLOBAL:-100000}"
export RATE_LIMIT_AUTH="${INTEGRATION_RATE_LIMIT_AUTH:-10000}"
export DOCUMENT_LIST_PAGE_SIZE="${INTEGRATION_DOCUMENT_LIST_PAGE_SIZE:-5}"
export SHARE_LINK_TTL_HOURS="${SHARE_LINK_TTL_HOURS:-168}"
export APP_BASE_URL="${APP_BASE_URL:-http://localhost:3000}"

LOG_DIR="/tmp/collab-integration"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
  local status=$?
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  # Wait, so the next run's port bind does not race this run's teardown. Without
  # it a second invocation fails with EADDRINUSE and looks like a broken test.
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
  done
  if [[ $status -ne 0 ]]; then
    echo
    echo "--- replica 1 (last 30 lines) ---" >&2
    tail -30 "$LOG_DIR/replica-1.log" 2>/dev/null || true
    echo "--- replica 2 (last 30 lines) ---" >&2
    tail -30 "$LOG_DIR/replica-2.log" 2>/dev/null || true
  fi
  exit $status
}
trap cleanup EXIT INT TERM

wait_for_health() {
  local base="$1" name="$2"
  for _ in $(seq 1 60); do
    if curl -sf "$base/health" >/dev/null 2>&1; then
      # Healthy is not enough: a replica reports 200 only when its own pub/sub
      # round trip completed, which is exactly the relay this lane depends on.
      local status
      status="$(curl -s "$base/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).status)}catch{process.stdout.write("unparseable")}})')"
      if [[ "$status" == "ok" ]]; then
        echo "  $name is healthy"
        return 0
      fi
    fi
    sleep 0.5
  done
  echo "$name never became healthy at $base/health" >&2
  return 1
}

echo "integration: preflight"
pnpm --filter @docs/db exec prisma migrate deploy >/dev/null
node scripts/db-drift.mjs
pnpm --filter @docs/db exec tsx prisma/seed.mts >/dev/null
echo "  migrations applied, no drift, seeded"

echo "integration: starting two sync replicas"
PORT=4100 pnpm --filter @docs/sync exec tsx src/main.ts >"$LOG_DIR/replica-1.log" 2>&1 &
PIDS+=($!)
PORT=4101 pnpm --filter @docs/sync exec tsx src/main.ts >"$LOG_DIR/replica-2.log" 2>&1 &
PIDS+=($!)

wait_for_health "$SYNC_BASE_URL" "replica 1"
wait_for_health "$SYNC_BASE_URL_2" "replica 2"

# The API suite boots the Nest graph in process on an ephemeral port, so there is
# no server to start here and no port to wait on. Deliberate: what it tests is
# the module graph -- a guard that is default-closed, a filter's mapping, a
# transaction that is really a transaction -- and a child process would put one
# more layer of guessing between a failure and its cause.
API_ONLY=0
if [[ "${1:-}" == "--api" ]]; then
  API_ONLY=1
  shift
fi

if [[ $API_ONLY -eq 0 ]]; then
  echo "integration: running the sync suite"
  if [[ $# -gt 0 ]]; then
    pnpm --filter @docs/sync exec vitest run --config vitest.integration.config.ts "$@"
  else
    pnpm --filter @docs/sync exec vitest run --config vitest.integration.config.ts
  fi
fi

# Re-seeded before the API suite. The sync suite above types into the seeded
# document and cuts versions from it, so running the API's assertions about the
# seed against that leftover state would make them depend on what ran first.
if [[ $# -eq 0 ]]; then
  echo "integration: re-seeding for the API suite"
  pnpm --filter @docs/db exec tsx prisma/seed.mts >/dev/null

  echo "integration: running the API suite"
  pnpm --filter @docs/api exec vitest run --config vitest.integration.config.ts
fi
