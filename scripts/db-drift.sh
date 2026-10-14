#!/usr/bin/env bash
#
# `.env` then node. The check itself is scripts/db-drift.mjs; this only supplies
# DATABASE_URL the same three-step way integration.sh and seed-check.sh do, so
# the lane runs identically here and on CI, where the URL arrives through the
# job's environment and no dotenv file is ever written.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://collab:collab@localhost:5440/collab?schema=public}"

exec node scripts/db-drift.mjs
