#!/usr/bin/env node
/**
 * Prove the live database matches what the repository says it should be.
 *
 * Two checks, because neither one covers the other.
 *
 * **1. `prisma migrate diff` against the datamodel.** `prisma migrate status`
 * does NOT do this, and believing it does is how this project's database spent a
 * day carrying a schema no migration file described. Measured on 2026-08-26,
 * after `20260825120000_init/migration.sql` was edited to remove a generated
 * `search` column:
 *
 *     $ prisma migrate status
 *     2 migrations found in prisma/migrations
 *     Database schema is up to date!
 *
 *     $ psql -c '\d documents'
 *     search | tsvector | generated always as (...) stored
 *
 *     $ sha256sum .../20260825120000_init/migration.sql
 *     fe86c89f...                       # _prisma_migrations says fd3bb212...
 *
 * `migrate status` reads the LEDGER -- which migration names have a
 * `finished_at` -- and never compares a column. An already-applied migration
 * that is edited afterwards is invisible to it, including the checksum change.
 *
 * **2. The raw-SQL objects, by name.** The diff in check 1 is blind to
 * everything Prisma's datamodel cannot express, which in this project is the
 * entire `collab_invariants` migration: the CHECK constraints, the one-owner
 * partial index, and the full-text GIN index on an EXPRESSION. Prisma would
 * report "no difference" against a database with none of them. So they are
 * asserted here by name, against `packages/db/src/constraints.ts`.
 *
 *   node scripts/db-drift.mjs
 *
 * 0 = the database matches. 1 = drift, with the SQL that would close it.
 * 2 = the check could not run, which is not the same as a pass.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPackage = join(repoRoot, 'packages', 'db');

function fail(message, detail) {
  console.error(`db-drift: ${message}`);
  if (detail !== undefined) console.error(`\n${detail}\n`);
  process.exit(1);
}

function cannotRun(message, detail) {
  console.error(`db-drift: ${message}`);
  if (detail !== undefined) console.error(`\n${detail}\n`);
  process.exit(2);
}

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  cannotRun('DATABASE_URL is not set. Source .env first, or run this through pnpm db:drift.');
}

// --- 1. The datamodel diff -------------------------------------------------

let diffSql;
try {
  diffSql = execFileSync(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'diff',
      '--from-url',
      databaseUrl,
      // Relative to `cwd` below, which is packages/db.
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    { cwd: dbPackage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  // Stderr is reported rather than discarded: a prisma that cannot reach the
  // database exits non-zero with the reason there, and swallowing it turns
  // "the check could not run" into "the check passed".
  cannotRun('prisma migrate diff failed to run.', `${error.stdout ?? ''}${error.stderr ?? ''}`);
}

const meaningful = diffSql.trim();
if (meaningful !== '' && !/this is an empty migration/iu.test(meaningful)) {
  fail(
    'the database does NOT match packages/db/prisma/schema.prisma. Prisma would need:',
    `${meaningful}\n\nReapply the migrations to a fresh database. Do not edit the schema to match the drift.`,
  );
}

// --- 2. The objects Prisma's datamodel cannot see --------------------------

const { PrismaClient } = await import(join(dbPackage, 'generated', 'client', 'index.js')).then(
  (module) => module.default ?? module,
);
const { DOCUMENT_SEARCH_VECTOR, CHECK_CONSTRAINTS, Prisma, UNIQUE_INDEXES } = await import(
  join(dbPackage, 'dist', 'index.js')
).then((module) => module.default ?? module);

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
try {
  const constraints = await prisma.$queryRaw`
    SELECT conname FROM pg_constraint WHERE contype = 'c'
  `;
  const present = new Set(constraints.map((row) => row.conname));
  const missing = Object.values(CHECK_CONSTRAINTS).filter((name) => !present.has(name));
  if (missing.length > 0) {
    fail(
      `${missing.length} CHECK constraint(s) from the collab_invariants migration are not in the database.`,
      missing.join('\n'),
    );
  }

  const indexes = await prisma.$queryRaw`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
  `;
  const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

  for (const name of Object.values(UNIQUE_INDEXES)) {
    if (!byName.has(name)) fail(`the ${name} index is not in the database.`);
  }

  const searchIndex = byName.get('documents_search_idx');
  if (searchIndex === undefined)
    fail('the full-text index documents_search_idx is not in the database.');
  // The distinction that matters, and the reason this check exists: an index on
  // a stored `search` COLUMN and an index on the to_tsvector EXPRESSION have the
  // same name and the same query plan, and only one of them survives the next
  // `prisma migrate diff`. See the comment in packages/db/prisma/schema.prisma.
  if (!/to_tsvector/iu.test(searchIndex)) {
    fail(
      'documents_search_idx indexes a COLUMN, not the to_tsvector expression.',
      `${searchIndex}\n\nThis database predates the expression index. Reapply the migrations to a fresh one.`,
    );
  }
  if (!searchIndex.includes("'A'") || !searchIndex.includes("'B'")) {
    fail('documents_search_idx has lost its setweight() ranking.', searchIndex);
  }

  // The index existing is not the same as the application being able to USE it.
  //
  // Postgres matches an expression index by comparing the PARSED expression, so
  // `DOCUMENT_SEARCH_VECTOR` -- the string `apps/api`'s search interpolates --
  // has to parse to exactly what the index was built on. One different
  // `coalesce`, one different weight letter, one different text-search
  // configuration and the query is still CORRECT: it returns the right rows, by
  // sequential scan, on every keystroke, with nothing in any log to say so.
  //
  // So the plan is read, with every alternative access path disabled. If the
  // planner cannot reach `documents_search_idx` even when a sequential scan is
  // forbidden, the expression does not match. The settings are session-local and
  // this connection is discarded immediately after.
  await prisma.$executeRawUnsafe('SET enable_seqscan = off');
  await prisma.$executeRawUnsafe('SET enable_indexscan = off');
  await prisma.$executeRawUnsafe('SET enable_indexonlyscan = off');

  const vector = Prisma.raw(DOCUMENT_SEARCH_VECTOR);
  const plan = await prisma.$queryRaw`
    EXPLAIN (FORMAT TEXT)
    SELECT "id" FROM "documents", websearch_to_tsquery('english', 'probe') q
     WHERE (${vector}) @@ q
  `;
  const planText = plan.map((row) => row['QUERY PLAN']).join('\n');
  if (!planText.includes('documents_search_idx')) {
    fail(
      'the search expression in @docs/db does not match the index the migration built.',
      `${planText}\n\nThe query is still correct -- and now runs as a sequential scan.\n` +
        `Expression: ${DOCUMENT_SEARCH_VECTOR}`,
    );
  }

  console.log(
    'db-drift: the database matches the schema, the CHECK constraints and the raw-SQL indexes.',
  );
  console.log(
    `db-drift: search index is on the expression, weighted: ${DOCUMENT_SEARCH_VECTOR.slice(0, 48)}...`,
  );
  console.log('db-drift: the search expression plans onto documents_search_idx.');
} finally {
  await prisma.$disconnect();
}
