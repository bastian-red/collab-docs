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
# Values the caller exported win over .env, so CI (which has no .env and sets
# DATABASE_URL in the job) and a one-off `DATABASE_URL=... pnpm db:seed` both
# behave as typed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    # Strip one layer of matching quotes, the way a shell `source` would.
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    if [[ -z "${!name+x}" ]]; then export "$name=$value"; fi
  done < "$ROOT/.env"
fi

exec "$@"
