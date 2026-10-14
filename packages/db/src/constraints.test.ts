import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as constraints from './constraints';
import { DOCUMENT_SEARCH_VECTOR } from './constraints';

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

/** Every migration's SQL, concatenated. Read from disk, never a copy. */
const sql = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8'))
  .join('\n');

/** Strip SQL line comments so a name mentioned only in prose does not count. */
const statements = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('every exported constraint name exists in a migration', () => {
  // The failure this catches: a constraint renamed in the migration while the
  // catch block still matches the old name. Nothing errors -- the catch simply
  // stops firing, and a conflict that used to be a clean 409 becomes a 500.
  const names = Object.entries(constraints).filter(
    ([key, value]) =>
      typeof value === 'string' &&
      !key.startsWith('PRISMA_') &&
      !key.startsWith('PG_') &&
      key !== 'DOCUMENT_SEARCH_VECTOR',
  );

  it('has a non-trivial number of them, so an empty export list cannot pass', () => {
    expect(names.length).toBeGreaterThan(12);
  });

  for (const [key, value] of names) {
    it(`${key} -> ${String(value)}`, () => {
      expect(statements).toContain(String(value));
    });
  }
});

describe('DOCUMENT_SEARCH_VECTOR', () => {
  it('is the expression the GIN index was actually built on', () => {
    // Postgres matches an expression index by comparing the parsed expression,
    // so whitespace is free but a changed coalesce, weight letter or text-search
    // configuration is not -- and the failure is a silent sequential scan, never
    // an error. Compare with whitespace collapsed, which is exactly the
    // difference Postgres forgives and no more.
    const collapse = (value: string) => value.replace(/\s+/gu, ' ').trim();

    const indexStatement = /CREATE INDEX "documents_search_idx"[^;]*;/u.exec(statements)?.[0];
    expect(indexStatement, 'the search index statement').toBeDefined();

    expect(collapse(indexStatement!)).toContain(collapse(DOCUMENT_SEARCH_VECTOR));
  });

  it('pins the text-search configuration rather than inheriting the database default', () => {
    // default_text_search_config is a per-database setting. An index built
    // against a different one is silently unusable.
    expect(DOCUMENT_SEARCH_VECTOR).not.toContain('to_tsvector(coalesce');
    expect([...DOCUMENT_SEARCH_VECTOR.matchAll(/'english'/gu)]).toHaveLength(2);
  });
});

describe('the invariants migration carries the constraints the design depends on', () => {
  // Named individually rather than counted, so deleting one is a failure with
  // the deleted rule's name in it.
  it.each([
    ['at most one owner', 'CREATE UNIQUE INDEX "document_members_one_owner"'],
    ['a link never grants ownership', `CHECK ("role" <> 'OWNER')`],
    ['the checkpoint is behind the allocator', 'CHECK ("next_seq" > "state_seq")'],
    ['no empty update in the log', 'CHECK (octet_length("update") > 0)'],
    ['a folder is not its own parent', 'CHECK ("id" <> "parent_id")'],
    ['the search index exists', 'USING GIN'],
  ])('%s', (_label, fragment) => {
    expect(statements).toContain(fragment);
  });
});

describe('the grouped exports', () => {
  it('cover every constraint name, so a new one cannot be added outside a group', () => {
    // The groups are what `scripts/db-drift.mjs` iterates. A name that exists as
    // a constant but is in no group is a constraint the drift check silently
    // does not look for -- which is worse than not having the check, because it
    // reports a pass.
    const grouped = new Set([
      ...Object.values(constraints.CHECK_CONSTRAINTS),
      ...Object.values(constraints.UNIQUE_INDEXES),
    ]);
    const named = Object.entries(constraints)
      .filter(([key, value]) => typeof value === 'string' && /^[A-Z_]+$/u.test(key))
      .filter(([key]) => !key.startsWith('PRISMA_') && !key.startsWith('PG_'))
      .filter(([key]) => key !== 'DOCUMENT_SEARCH_VECTOR')
      .map(([, value]) => value as string);

    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(grouped, name).toContain(name);
  });

  it('puts each name in exactly one group', () => {
    // Widened to `string[]` deliberately. The two groups have disjoint literal
    // types today, so `includes` on the narrow types does not compile -- which
    // is a stronger guarantee than this test, and also the reason the test still
    // has to exist: the moment somebody adds a name to both groups those types
    // overlap, the compile error goes away, and only a value-level check notices.
    const checks: string[] = Object.values(constraints.CHECK_CONSTRAINTS);
    const indexes: string[] = Object.values(constraints.UNIQUE_INDEXES);
    expect(checks.filter((name) => indexes.includes(name))).toEqual([]);
  });

  it('cannot be mutated by a caller', () => {
    expect(Object.isFrozen(constraints.CHECK_CONSTRAINTS)).toBe(true);
    expect(Object.isFrozen(constraints.UNIQUE_INDEXES)).toBe(true);
  });
});
