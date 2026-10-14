/**
 * The names Postgres will use when it refuses a write.
 *
 * Catch blocks match on these, never on the message text. Postgres owns the
 * wording and changes it between minor versions; the constraint name is ours and
 * is set explicitly in the migration.
 *
 * Two vocabularies, because two clients report the same violation differently:
 * Prisma's typed client raises `PrismaClientKnownRequestError` with a `code` like
 * `P2002`, while `$queryRaw` surfaces the SQLSTATE (`23505`) instead. A predicate
 * that only reads one of them is right half the time -- and project004 shipped
 * exactly that bug, where every budget conflict became a 500 while its unit
 * tests passed against a fixture no client ever produces.
 */

// --- Prisma's typed client -------------------------------------------------
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
export const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';
export const PRISMA_NOT_FOUND = 'P2025';

// --- SQLSTATE, as seen through $queryRaw -----------------------------------
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

// --- Constraint names, from the migrations ---------------------------------
/** At most one OWNER per document. Partial unique index. */
export const ONE_OWNER_PER_DOCUMENT = 'document_members_one_owner';
/** A share link can never carry OWNER. */
export const SHARE_LINK_ROLE_NOT_OWNER = 'share_links_role_not_owner';
export const SHARE_LINK_REVOKED_AFTER_CREATED = 'share_links_revoked_after_created';
/** The checkpoint can never claim updates the allocator has not handed out. */
export const STATE_SEQ_BEHIND_NEXT_SEQ = 'documents_state_seq_behind_next_seq';
export const STATE_SEQ_NON_NEGATIVE = 'documents_state_seq_non_negative';
export const DOCUMENT_STATE_NOT_EMPTY = 'documents_state_not_empty';
export const UPDATE_SEQ_POSITIVE = 'document_updates_seq_positive';
export const UPDATE_NOT_EMPTY = 'document_updates_not_empty';
/** The append log's primary key. This is what makes `seq` gapless under races. */
export const UPDATE_SEQ_PRIMARY_KEY = 'document_updates_pkey';
export const VERSION_N_UNIQUE = 'document_versions_document_id_n_key';
export const VERSION_N_POSITIVE = 'document_versions_n_positive';
export const VERSION_MANUAL_HAS_LABEL = 'document_versions_manual_has_label';
export const VERSION_STATE_NOT_EMPTY = 'document_versions_state_not_empty';
export const FOLDER_NOT_OWN_PARENT = 'folders_not_own_parent';
export const SHARE_LINK_TOKEN_UNIQUE = 'share_links_token_key';
export const USER_EMAIL_UNIQUE = 'users_email_key';

/**
 * The same names, grouped by what kind of object they are.
 *
 * Not a second list: every group is built from the constants above, and
 * `constraints.test.ts` asserts that every exported name appears in exactly one
 * group. A caller that needs to check "are they all there" -- which is what
 * `scripts/db-drift.mjs` does against `pg_constraint` and `pg_indexes` -- would
 * otherwise have to keep its own copy, and a copy that is one name short passes
 * while the constraint it forgot is missing from the database.
 */
export const CHECK_CONSTRAINTS = Object.freeze({
  SHARE_LINK_ROLE_NOT_OWNER,
  SHARE_LINK_REVOKED_AFTER_CREATED,
  STATE_SEQ_BEHIND_NEXT_SEQ,
  STATE_SEQ_NON_NEGATIVE,
  DOCUMENT_STATE_NOT_EMPTY,
  UPDATE_SEQ_POSITIVE,
  UPDATE_NOT_EMPTY,
  VERSION_N_POSITIVE,
  VERSION_MANUAL_HAS_LABEL,
  VERSION_STATE_NOT_EMPTY,
  FOLDER_NOT_OWN_PARENT,
});

/**
 * Unique indexes and primary keys, including the one Prisma's datamodel cannot
 * express: `document_members_one_owner` is a PARTIAL unique index
 * (`WHERE role = 'OWNER'`), which is why it lives in the raw migration and why a
 * `prisma migrate diff` is blind to its absence.
 */
export const UNIQUE_INDEXES = Object.freeze({
  ONE_OWNER_PER_DOCUMENT,
  UPDATE_SEQ_PRIMARY_KEY,
  VERSION_N_UNIQUE,
  SHARE_LINK_TOKEN_UNIQUE,
  USER_EMAIL_UNIQUE,
});

/**
 * The COLUMNS each unique index covers, as Postgres names them.
 *
 * This exists because the constraint NAME is not what the typed client reports.
 * Measured against `@prisma/client@5.22.0` and this schema on 2026-08-26, by
 * provoking each violation and printing `error.meta`:
 *
 *     users_email_key                       target: ["email"]
 *     document_versions_document_id_n_key   target: ["document_id","n"]
 *     document_members_one_owner            target: ["document_id"]
 *     share_links_token_key                 target: ["token"]
 *     document_updates_pkey                 target: ["document_id","seq"]
 *
 * Not one of them is the index's name, and the message text does not carry it
 * either -- it reads `Unique constraint failed on the fields: (...)`. So a catch
 * block matching on the name is a catch block that never fires, and the symptom
 * is a 500 where a 409 belonged: a duplicate sign-up reported as a server fault.
 * That is exactly the bug this project's integration lane found in
 * `AuthService.signUp`, and it was invisible to a unit test written against the
 * shape `$queryRaw` produces.
 *
 * `$queryRaw` is the other half and it behaves the opposite way: no `code`, no
 * `meta`, and the constraint NAME inside the message. `violatedUniqueIndex` in
 * `errors.ts` reads both, which is the only way to be right for both clients.
 *
 * Columns are database names (snake_case, after `@map`), because that is what
 * Prisma reports here. Do not "correct" them to the Prisma field names.
 */
export const UNIQUE_INDEX_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [ONE_OWNER_PER_DOCUMENT]: Object.freeze(['document_id']),
  [UPDATE_SEQ_PRIMARY_KEY]: Object.freeze(['document_id', 'seq']),
  [VERSION_N_UNIQUE]: Object.freeze(['document_id', 'n']),
  [SHARE_LINK_TOKEN_UNIQUE]: Object.freeze(['token']),
  [USER_EMAIL_UNIQUE]: Object.freeze(['email']),
});

/**
 * The full-text expression, character for character as it appears in the GIN
 * index.
 *
 * Postgres matches an expression index by comparing the parsed expression, so a
 * query that differs only in whitespace still matches -- but one that differs in
 * a `coalesce`, a weight letter or the text-search configuration does not, and
 * the failure is a silent sequential scan rather than an error. Keeping the
 * string here, and asserting in a test that it is the same string the migration
 * created, is what stops the two drifting apart unnoticed.
 */
export const DOCUMENT_SEARCH_VECTOR =
  "setweight(to_tsvector('english', coalesce(\"title\", '')), 'A') || " +
  "setweight(to_tsvector('english', coalesce(\"content_text\", '')), 'B')";
