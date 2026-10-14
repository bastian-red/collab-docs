# shellcheck shell=bash
#
# Sourced, not executed: `. scripts/load-env.sh` from a script's repo root.
#
# One precedence for every lane script, highest first:
#
#   1. the caller's environment   (CI job `env:` blocks, a one-off VAR=... prefix)
#   2. .env                        (a developer's machine)
#   3. .env.example                (the documented defaults)
#
# Why the third step exists: CI writes no .env, and each script used to carry its
# own hand-picked list of fallbacks. The first CI run of the e2e lane died with
# "DOCUMENT_LIST_PAGE_SIZE: Required" because that list had drifted from what the
# API actually requires, and locally a .env hid it. .env.example is already the
# documented, contract-checked list of every name (scripts/env-contract.mjs), so
# it is the fallback rather than a second copy of it.
#
# Nothing is overridden: a name already set, even to an empty string, is kept.
load_env_file() {
  local file="$1" line name value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    if [[ -z "${!name+x}" ]]; then export "$name=$value"; fi
  done <"$file"
}

load_env_file .env
load_env_file .env.example
