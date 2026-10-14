#!/usr/bin/env bash
#
# Prove the seed is deterministic and idempotent, against a real database.
#
# Two properties, both of which everything downstream assumes and neither of
# which a unit test can see:
#
#   deterministic - two runs produce the same workspace. The E2E suite signs in as
#                   a named person, opens a named document and asserts on a known
#                   paragraph, and the README quotes those; a generator that
#                   drifts turns those into flaky failures that look like product
#                   bugs.
#   idempotent    - running it twice leaves one workspace, not two. A missing
#                   cascade, or a teardown that runs in the wrong order against a
#                   SET NULL foreign key, shows up here as a doubled row count and
#                   nowhere else. `documents.folder_id` and
#                   `share_links.created_by_id` are both SET NULL, so deleting the
#                   users FIRST would orphan every document rather than remove it.
#
# The digest covers content only: each document's title, its state_seq, the seq
# and author of every un-compacted update, its members' roles, its versions and
# its links' states. Primary keys are excluded where they are cuids; the seeded
# rows use fixed `seed-` ids, so those are digestible and are digested.
#
# `seq` IS in the digest. The sequence is dense and allocated by
# `UPDATE documents SET next_seq = next_seq + 1 RETURNING`, so a deterministic
# seed must produce byte-identical seqs. If it does not, either the seed is racing
# itself or the allocator is not doing what the whole project claims it does.
#
# The Yjs BYTES are deliberately NOT digested. Two encodings of one document
# differ byte for byte -- the update format is not canonical -- so digesting
# `state` would report a correct seed as non-deterministic on every run. What is
# digested instead is `content_text`, which is the projection the search index
# reads and the thing a person would notice changing.
#
#   ./scripts/seed-check.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

# `.env` when there is one, the environment otherwise, and .env.example's value
# as the last resort -- the same three-step shape scripts/integration.sh and
# scripts/e2e.sh use. Requiring `.env` outright is fine locally and wrong on CI,
# where the job hands DATABASE_URL in through its `env:` block and never writes a
# dotenv file.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://collab:collab@localhost:5440/collab?schema=public}"

# Prisma's URL carries `?schema=public`, which libpq rejects outright.
PSQL_URL="${DATABASE_URL%%\?*}"

# Read out of the seed rather than retyped, for the same reason
# scripts/dev-smoke.sh reads it: a copy that drifts produces a digest confidently
# computed over zero rows, which passes.
DEMO_EMAIL="$(sed -n "s/^const DEMO_EMAIL = '\([^']*\)';.*/\1/p" packages/db/prisma/seed.mts)"
DEMO_DOCUMENT="$(sed -n "s/^const DEMO_DOCUMENT = '\([^']*\)';.*/\1/p" packages/db/prisma/seed.mts)"
DEMO_PARAGRAPH="$(sed -n "s/^const DEMO_PARAGRAPH = '\([^']*\)';.*/\1/p" packages/db/prisma/seed.mts)"
[[ -n "$DEMO_EMAIL" ]] ||
  { echo "could not read DEMO_EMAIL out of packages/db/prisma/seed.mts." >&2; exit 1; }
[[ -n "$DEMO_DOCUMENT" ]] ||
  { echo "could not read DEMO_DOCUMENT out of packages/db/prisma/seed.mts." >&2; exit 1; }
[[ -n "$DEMO_PARAGRAPH" ]] ||
  { echo "could not read DEMO_PARAGRAPH out of packages/db/prisma/seed.mts." >&2; exit 1; }

# `string_agg` needs the ORDER BY: without it the row order is whatever the
# planner produced, and the digest changes between two identical workspaces.
#
# Scoped to the documents the demo account is a member of, so a stray row left by
# some other lane cannot move the digest.
read -r -d '' DIGEST_SQL <<'SQL_END' || true
SELECT count(*) || ' ' || coalesce(md5(string_agg(x, '|' ORDER BY x)), '-')
FROM (
  SELECT d.id
         || ':' || d.title
         || ':' || d.state_seq
         || ':' || d.next_seq
         || ':' || (d.deleted_at IS NOT NULL)
         || ':' || md5(d.content_text)
         || ':' || coalesce(
              (SELECT string_agg(u.seq || '/' || coalesce(a.email, '-'), ',' ORDER BY u.seq)
                 FROM document_updates u
                 -- LEFT, because author_id is SET NULL on user delete and an
                 -- update outlives its author. An INNER join would silently drop
                 -- exactly the rows that prove the orphan handling works.
                 LEFT JOIN users a ON a.id = u.author_id
                WHERE u.document_id = d.id), '-')
         || ':' || coalesce(
              (SELECT string_agg(m.role || '/' || mu.email, ',' ORDER BY mu.email)
                 FROM document_members m
                 JOIN users mu ON mu.id = m.user_id
                WHERE m.document_id = d.id), '-')
         || ':' || coalesce(
              (SELECT string_agg(v.n || '/' || v.kind || '/' || coalesce(v.label, '-'), ',' ORDER BY v.n)
                 FROM document_versions v
                WHERE v.document_id = d.id), '-')
         || ':' || coalesce(
              (SELECT string_agg(l.role || '/' || (l.revoked_at IS NOT NULL), ',' ORDER BY l.token)
                 FROM share_links l
                WHERE l.document_id = d.id), '-') AS x
  FROM documents d
  WHERE EXISTS (
    SELECT 1 FROM document_members dm
      JOIN users demo ON demo.id = dm.user_id
     WHERE dm.document_id = d.id AND demo.email = :'demo_email'
  )
) workspace;
SQL_END

# The SQL goes in on stdin, not through --command, and that is not a style
# choice: psql performs variable interpolation on input it reads, and does NOT
# perform it on a string given with -c. With --command the `:'demo_email'` above
# reaches the server verbatim and Postgres answers
#
#   ERROR:  syntax error at or near ":"
digest() {
  printf '%s\n' "$DIGEST_SQL" |
    psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align \
      --variable "demo_email=${DEMO_EMAIL}"
}

# Five invariants the digest cannot see, asked of Postgres directly. Each is
# something the schema is supposed to make impossible, so a non-zero answer means
# a constraint from the collab_invariants migration is missing or was dropped --
# and every one of them would otherwise ship green.
#
#   dup_seq    - two updates sharing a (document_id, seq). The primary key forbids
#                it. Two updates at one seq is a replay whose order is decided by
#                the planner.
#   behind     - a document whose next_seq is not strictly above its state_seq,
#                which means a checkpoint claiming updates the allocator never
#                handed out. `documents_state_seq_behind_next_seq` forbids it.
#   orphaned   - an update at or below its document's state_seq: a row the
#                checkpoint already contains and the truncation failed to remove.
#                Harmless to correctness (Yjs updates are idempotent) and a sign
#                that compaction's two halves are not in one transaction.
#   owners     - a document with two OWNERs, which `document_members_one_owner`
#                (a partial unique index, the only way to say "at most one" in
#                Postgres) forbids. Two owners makes "who may delete this" a query
#                with two answers.
#   owner_link - a share link carrying OWNER, which `share_links_role_not_owner`
#                forbids. A link is forwardable; a forwardable link that hands
#                away the document is how somebody loses one.
read -r -d '' INVARIANT_SQL <<'SQL_END' || true
SELECT
  (SELECT coalesce(sum(n - 1), 0) FROM (
     SELECT count(*) AS n FROM document_updates GROUP BY document_id, seq HAVING count(*) > 1
   ) d)
  || '|' ||
  (SELECT count(*) FROM documents WHERE next_seq <= state_seq)
  || '|' ||
  (SELECT count(*) FROM document_updates u
     JOIN documents d ON d.id = u.document_id
    WHERE u.seq <= d.state_seq)
  || '|' ||
  (SELECT count(*) FROM (
     SELECT document_id FROM document_members WHERE role = 'OWNER'
      GROUP BY document_id HAVING count(*) > 1
   ) o)
  || '|' ||
  (SELECT count(*) FROM share_links WHERE role = 'OWNER');
SQL_END

run_seed() {
  pnpm --filter @docs/db exec tsx prisma/seed.mts >/dev/null
}

echo "seed-check: first run"
run_seed
FIRST="$(digest)"
echo "  $FIRST"

echo "seed-check: second run"
run_seed
SECOND="$(digest)"
echo "  $SECOND"

if [[ "$FIRST" != "$SECOND" ]]; then
  echo >&2
  echo "FAIL: the seed is not deterministic or not idempotent." >&2
  echo "  run 1: $FIRST" >&2
  echo "  run 2: $SECOND" >&2
  echo "A changed document count means the teardown left rows behind, or a cascade" >&2
  echo "is missing. The same count with a changed digest means something in the" >&2
  echo "generator reads the clock or Math.random, or that a Y.Doc was left with its" >&2
  echo "random clientID and the seq allocation followed a different order." >&2
  exit 1
fi

if [[ "${FIRST%% *}" == "0" ]]; then
  echo "FAIL: the seed produced no documents." >&2
  echo "A digest over zero rows is stable across two runs and proves nothing." >&2
  exit 1
fi

INVARIANTS="$(printf '%s\n' "$INVARIANT_SQL" |
  psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align)"
IFS='|' read -r DUP_SEQ BEHIND ORPHANED MULTI_OWNER OWNER_LINK <<<"$INVARIANTS"

failed=0
if [[ "$DUP_SEQ" != "0" ]]; then
  echo "FAIL: ${DUP_SEQ} update(s) share a (document_id, seq) with another update." >&2
  echo "The document_updates primary key is missing or was dropped." >&2
  failed=1
fi
if [[ "$BEHIND" != "0" ]]; then
  echo "FAIL: ${BEHIND} document(s) have next_seq <= state_seq." >&2
  echo "The checkpoint claims updates the allocator never handed out, so the next" >&2
  echo "compaction would truncate rows it does not contain." >&2
  failed=1
fi
if [[ "$ORPHANED" != "0" ]]; then
  echo "FAIL: ${ORPHANED} update(s) sit at or below their document's state_seq." >&2
  echo "Compaction wrote the checkpoint and did not truncate. Harmless to the text," >&2
  echo "because Yjs updates are idempotent -- and a sign that the two halves are not" >&2
  echo "in one transaction, which is the one window that is NOT safe." >&2
  failed=1
fi
if [[ "$MULTI_OWNER" != "0" ]]; then
  echo "FAIL: ${MULTI_OWNER} document(s) have more than one OWNER." >&2
  echo "document_members_one_owner is missing or was dropped." >&2
  failed=1
fi
if [[ "$OWNER_LINK" != "0" ]]; then
  echo "FAIL: ${OWNER_LINK} share link(s) carry OWNER." >&2
  echo "share_links_role_not_owner is missing or was dropped." >&2
  failed=1
fi

# The demo document has to be reachable by the exact strings the E2E suite and
# the README use. A seed that renamed it, or compacted the whole log so the
# paragraph the replay produces is no longer only in the log, passes every check
# above and breaks the lane that matters.
PENDING="$(printf 'SELECT count(*) FROM document_updates u JOIN documents d ON d.id = u.document_id WHERE d.title = %s;\n' "$(printf "'%s'" "${DEMO_DOCUMENT//\'/\'\'}")" |
  psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align)"
if [[ "$PENDING" == "0" ]]; then
  echo "FAIL: \"${DEMO_DOCUMENT}\" has no un-compacted updates." >&2
  echo "The demo document is meant to load through checkpoint AND replay, so a" >&2
  echo "fresh clone exercises the replay path on its first page view." >&2
  failed=1
fi

CHECKPOINTED="$(printf 'SELECT count(*) FROM documents WHERE content_text LIKE %s;\n' "$(printf "'%%%s%%'" "${DEMO_PARAGRAPH//\'/\'\'}")" |
  psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align)"
if [[ "$CHECKPOINTED" == "0" ]]; then
  echo "FAIL: the demo paragraph is not in any document's content_text." >&2
  echo "content_text is refreshed at compaction and is what full-text search reads;" >&2
  echo "if the paragraph never reached it, search finds nothing on a fresh clone." >&2
  failed=1
fi

[[ $failed -eq 0 ]] || exit 1

echo
echo "PASS: two runs, ${FIRST%% *} documents, identical content digest,"
echo "      no duplicate seq, no checkpoint ahead of its allocator, no un-truncated"
echo "      update, at most one owner each, no link carrying OWNER,"
echo "      \"${DEMO_DOCUMENT}\" left mid-log and its checkpointed text searchable."
