#!/usr/bin/env bash
#
# Run a command with the repo's .env loaded, without overriding anything the
# caller already exported.
#
# Why it exists: `pnpm db:deploy` and `pnpm db:seed` are turbo tasks, and turbo
# reads no dotenv file. From a fresh clone, `cp .env.example .env && pnpm db:seed`
# died with "Environment variable not found: DATABASE_URL" -- the README's own
# steps, failing on the second command. `pnpm dev` already goes through
# scripts/dev.sh for the same reason; the database commands now do too.
#
# Precedence is caller env > .env > .env.example (scripts/load-env.sh), so CI
# (no .env, DATABASE_URL in the job) and a one-off `DATABASE_URL=... pnpm db:seed`
# both behave as typed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

exec "$@"
