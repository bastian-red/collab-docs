-- Everything the Prisma schema cannot express.
--
-- Each constraint here is a rule the application also enforces. That is not
-- redundancy: the application enforces it for the user, the database enforces it
-- for the application. A bug in a service, a hand-run UPDATE during an incident,
-- or a second writer added later all bypass the first and none of them bypass
-- the second.
--
-- Every name below is exported from packages/db/src/index.ts. Catch blocks match
-- on the name, never on the message text, because the message text is Postgres's
-- to change between minor versions.

-- ---------------------------------------------------------------------------
-- 1. Exactly one OWNER per document
-- ---------------------------------------------------------------------------
-- A partial unique index, which is the only way to say "at most one row where
-- role = 'OWNER'" without a trigger. Transferring ownership is therefore a
-- single transaction that demotes the old owner and promotes the new one; two
-- concurrent transfers cannot both succeed and leave a document with two owners
-- who can each remove the other.
--
-- "At most one" rather than "exactly one": the application always creates a
-- document with an owner, and a NOT EXISTS check cannot be a constraint. The
-- integration lane asserts the application half.
CREATE UNIQUE INDEX "document_members_one_owner"
    ON "document_members" ("document_id")
    WHERE "role" = 'OWNER';

-- ---------------------------------------------------------------------------
-- 2. A share link can never grant ownership
-- ---------------------------------------------------------------------------
-- The third of three places this is enforced (the others are SHARE_ROLES in
-- packages/shared and the check in services/doc-access). A link is forwardable
-- and lives in a URL somebody pastes into a chat; one that hands away the
-- document is not a sharing feature, it is a way to lose one.
ALTER TABLE "share_links"
    ADD CONSTRAINT "share_links_role_not_owner"
    CHECK ("role" <> 'OWNER');

-- A link cannot be revoked before it was created, which would make "was this
-- link live at time T" unanswerable.
ALTER TABLE "share_links"
    ADD CONSTRAINT "share_links_revoked_after_created"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at");

-- ---------------------------------------------------------------------------
-- 3. The checkpoint is always behind the allocator
-- ---------------------------------------------------------------------------
-- `next_seq` is the NEXT number to hand out, `state_seq` is the highest one
-- already folded into `documents.state`. So `next_seq` is strictly greater,
-- always, and a fresh document is (state_seq 0, next_seq 1).
--
-- What this stops: a compaction that writes a `state_seq` it did not actually
-- fold in. The load path would then skip real updates -- it replays everything
-- ABOVE state_seq -- and the document would silently lose whatever sat in the
-- gap. That is the one failure in this design that produces a wrong document
-- rather than a slow one, so it is a constraint and not a code comment.
ALTER TABLE "documents"
    ADD CONSTRAINT "documents_state_seq_behind_next_seq"
    CHECK ("next_seq" > "state_seq");

ALTER TABLE "documents"
    ADD CONSTRAINT "documents_state_seq_non_negative"
    CHECK ("state_seq" >= 0);

-- ---------------------------------------------------------------------------
-- 4. The log's sequence numbers are real
-- ---------------------------------------------------------------------------
-- seq starts at 1, because 0 is the sentinel meaning "nothing compacted yet" in
-- documents.state_seq. A seq of 0 would make a fresh document's checkpoint claim
-- to contain an update.
ALTER TABLE "document_updates"
    ADD CONSTRAINT "document_updates_seq_positive"
    CHECK ("seq" >= 1);

-- An empty update is not a Yjs update; it is a bug in the append path that would
-- replay as a no-op forever and be invisible.
ALTER TABLE "document_updates"
    ADD CONSTRAINT "document_updates_not_empty"
    CHECK (octet_length("update") > 0);

-- ---------------------------------------------------------------------------
-- 5. Versions
-- ---------------------------------------------------------------------------
-- Dense from 1. UNIQUE (document_id, n) is in the Prisma schema; this is the
-- floor.
ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_n_positive"
    CHECK ("n" >= 1);

-- A MANUAL version is one a person named, and that is exactly what makes it
-- exempt from pruning. An unlabelled MANUAL version would be pruned as though it
-- were automatic while claiming in the UI to be somebody's deliberate save.
ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_manual_has_label"
    CHECK ("kind" <> 'MANUAL' OR ("label" IS NOT NULL AND length(btrim("label")) > 0));

-- The state of an empty document is a two-byte Yjs update, never zero bytes.
ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_state_not_empty"
    CHECK (octet_length("state") > 0);

ALTER TABLE "documents"
    ADD CONSTRAINT "documents_state_not_empty"
    CHECK (octet_length("state") > 0);

-- ---------------------------------------------------------------------------
-- 6. A folder is not its own parent
-- ---------------------------------------------------------------------------
-- Only the one-node cycle can be a CHECK; longer cycles need a recursive query
-- and are refused in services/doc-access. Both matter, because a cycle here is
-- not a bad render -- it is a breadcrumb walk that never terminates.
ALTER TABLE "folders"
    ADD CONSTRAINT "folders_not_own_parent"
    CHECK ("id" <> "parent_id");

-- ---------------------------------------------------------------------------
-- 7. Full-text search
-- ---------------------------------------------------------------------------
-- An EXPRESSION index, not a stored `tsvector` column, and the reason is a
-- measured one rather than a preference.
--
-- A stored column would have to appear in schema.prisma as `Unsupported()`,
-- which carries a type name and nothing else. Prisma then reads the column's
-- GENERATED ALWAYS expression as an ordinary column default and emits
-- `ALTER COLUMN "search" DROP DEFAULT` on the next migration. That does not
-- fail: it succeeds, converts the column to a plain one, and from then on the
-- vector is whatever it happened to hold at that moment. Search silently stops
-- seeing anything written after the migration. `prisma migrate diff --from-url`
-- printed that statement against the first version of this file, which is why
-- this version exists.
--
-- With no column there is nothing for Prisma to represent and nothing to drift.
-- The query has to repeat the expression exactly -- character for character, or
-- the planner will not match the index -- so it lives in exactly one place, as
-- DOCUMENT_SEARCH_VECTOR in packages/db/src/index.ts, and a test asserts the two
-- strings agree.
--
-- Nothing is lost by not storing it: `ts_headline` takes the original TEXT, not
-- a tsvector, so the snippet never read the column.
--
-- 'english' is pinned rather than taken from default_text_search_config, which
-- is a per-database setting: an index built against a different config would be
-- silently unusable, and the query would fall back to a sequential scan.
--
-- setweight ranks a title match above a body match. content_text is refreshed
-- only at compaction, so this index is written once per checkpoint rather than
-- once per keystroke, which is what makes GIN (slow to write, fast to read) the
-- right choice over GiST.
CREATE INDEX "documents_search_idx" ON "documents" USING GIN ((
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("content_text", '')), 'B')
));

-- ---------------------------------------------------------------------------
-- 8. A deleted document keeps its log
-- ---------------------------------------------------------------------------
-- deleted_at is a tombstone, never a row removal, so "restore from trash" is an
-- UPDATE rather than an undelete. This index keeps the list query -- which is
-- always filtered on it -- off a sequential scan.
CREATE INDEX "documents_live_updated_at_idx"
    ON "documents" ("updated_at" DESC)
    WHERE "deleted_at" IS NULL;
