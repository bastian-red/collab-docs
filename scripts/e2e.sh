#!/usr/bin/env bash
#
# The E2E lane: build in production mode, reseed, start api + sync + web, run
# Playwright. Arguments go straight to `playwright test`.
#
# This lane supplies its own environment and starts the apps directly, bypassing
# turbo -- which is exactly why it proves nothing about whether the documented
# `pnpm dev` works. That is scripts/dev-smoke.sh's job, and it strips the
# environment first (docs/SPECS.md 9.3).
#
# Rate limits are lifted far above their defaults: the suite signs in dozens of
# times from one address in a minute, and a 5/minute auth budget would turn every
# later spec into a 429. Nothing here asserts a 429.
#
# Usage: ./scripts/e2e.sh [playwright args...]
set -euo pipefail
set -m # each background job leads its own process group, so cleanup kills the whole tree

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-/tmp/collab-e2e}"
mkdir -p "$LOG_DIR"
API_LOG="$LOG_DIR/api.log"
SYNC_LOG="$LOG_DIR/sync.log"
WEB_LOG="$LOG_DIR/web.log"
API_PID=""
SYNC_PID=""
WEB_PID=""
WAIT_SECONDS="${WAIT_SECONDS:-90}"

cleanup() {
  for pid in "$WEB_PID" "$SYNC_PID" "$API_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

# Caller env > .env > .env.example (scripts/load-env.sh says why).
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

export DATABASE_URL="${DATABASE_URL:-postgresql://collab:collab@localhost:5440/collab?schema=public}"
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6386}"
export AUTH_SECRET="${AUTH_SECRET:-ci-secret-at-least-32-characters-long}"
export APP_VERSION="${APP_VERSION:-0.1.0}"
export API_PORT="${API_PORT:-4000}"
export SYNC_PORT="${SYNC_PORT:-4100}"
export WEB_PORT="${WEB_PORT:-3000}"
export PORT=""
export API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
export SYNC_BASE_URL="${SYNC_BASE_URL:-http://localhost:${SYNC_PORT}}"
export SYNC_BASE_URL_2=""
export NEXT_PUBLIC_SYNC_URL="${NEXT_PUBLIC_SYNC_URL:-ws://localhost:${SYNC_PORT}}"
export APP_BASE_URL="${APP_BASE_URL:-http://localhost:${WEB_PORT}}"
export AUTH_URL="${AUTH_URL:-$APP_BASE_URL}"
export RATE_LIMIT_GLOBAL=100000
export RATE_LIMIT_AUTH=90000
export SYNC_MESSAGE_RATE_LIMIT=100000

check_reachable() {
  local url="$1" label="$2" host port
  if [[ ! "$url" =~ ^[a-z+]+://([^@/]*@)?([^:/?#]+):([0-9]+) ]]; then
    return 0
  fi
  host="${BASH_REMATCH[2]}"
  port="${BASH_REMATCH[3]}"
  if ! (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
    echo "${label} is not reachable at ${host}:${port}. Start the datastores:" >&2
    echo "  docker compose -f infra/docker-compose.yml up -d" >&2
    return 1
  fi
}
failed=0
check_reachable "$DATABASE_URL" Postgres || failed=1
check_reachable "$REDIS_URL" Redis || failed=1
[[ $failed -eq 0 ]] || exit 1

# Refuse to run against something already listening: the suite would test that
# instead, with whatever environment and build it happens to have.
for url in "${API_BASE_URL}/health" "${SYNC_BASE_URL}/health" "${APP_BASE_URL}/sign-in"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    echo "Something is already serving ${url}. Stop it first (pnpm dev?)." >&2
    exit 1
  fi
done

echo "==> Building (production)"
NODE_ENV=production pnpm build >"$LOG_DIR/build.log" 2>&1 || {
  tail -40 "$LOG_DIR/build.log" >&2
  exit 1
}

echo "==> Applying migrations and seeding"
pnpm --filter @docs/db exec prisma migrate deploy >/dev/null
pnpm --filter @docs/db run seed >"$LOG_DIR/seed.log" 2>&1 || {
  tail -30 "$LOG_DIR/seed.log" >&2
  exit 1
}

echo "==> Starting api :${API_PORT}, sync :${SYNC_PORT}, web :${WEB_PORT} (logs in ${LOG_DIR})"
node apps/api/dist/main.js >"$API_LOG" 2>&1 &
API_PID=$!
node apps/sync/dist/main.js >"$SYNC_LOG" 2>&1 &
SYNC_PID=$!
(cd apps/web && exec node_modules/.bin/next start -p "$WEB_PORT") >"$WEB_LOG" 2>&1 &
WEB_PID=$!

wait_for() {
  local url="$1" name="$2" pid="$3" log="$4"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "${name} exited during startup. Last 30 lines of ${log}:" >&2
      tail -30 "$log" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 30 lines of ${log}:" >&2
  tail -30 "$log" >&2
  exit 1
}
wait_for "${API_BASE_URL}/health" api "$API_PID" "$API_LOG"
wait_for "${SYNC_BASE_URL}/health" sync "$SYNC_PID" "$SYNC_LOG"
wait_for "${APP_BASE_URL}/sign-in" web "$WEB_PID" "$WEB_LOG"

echo "==> Running Playwright"
pnpm --filter @docs/e2e exec playwright test "$@"
