import { isDomainError } from '@docs/shared';
import { describe, expect, it } from 'vitest';

import {
  FOLDER_ANCESTRY_LIMIT,
  FOLDER_MAX_DEPTH,
  ancestryOf,
  assertFolderMove,
  depthUnder,
  type FolderRow,
} from './folders';

function table(rows: FolderRow[]): (id: string) => Promise<FolderRow | null> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return async (id) => byId.get(id) ?? null;
}

const FLAT: FolderRow[] = [
  { id: 'root', parentId: null },
  { id: 'child', parentId: 'root' },
];

describe('ancestryOf', () => {
  it('is the folder itself for a root', async () => {
    expect(await ancestryOf('root', table(FLAT))).toEqual(['root']);
  });

  it('runs nearest first', async () => {
    expect(await ancestryOf('child', table(FLAT))).toEqual(['child', 'root']);
  });

  it('stops rather than spinning when the rows already form a cycle', async () => {
    // Not reachable through the API, which is what this file exists to ensure.
    // Reachable through a hand-written UPDATE or a restored dump, and the
    // failure mode without this branch is a request thread that never returns.
    const cyclic = table([
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]);
    await expect(ancestryOf('a', cyclic)).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === 'CONFLICT',
    );
  });

  it('refuses a chain longer than the walk allows', async () => {
    const deep: FolderRow[] = Array.from(
      { length: FOLDER_ANCESTRY_LIMIT + 5 },
      (_unused, index) => ({
        id: `f${index}`,
        parentId: index === 0 ? null : `f${index - 1}`,
      }),
    );
    const leaf = `f${deep.length - 1}`;
    await expect(ancestryOf(leaf, table(deep))).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === 'CONFLICT',
    );
  });

  it('can observe a chain one deeper than the product allows, so the move check can refuse it', () => {
    // If the walk stopped at FOLDER_MAX_DEPTH it could never distinguish "at the
    // limit" from "over it", and the cap would be unenforceable.
    expect(FOLDER_ANCESTRY_LIMIT).toBeGreaterThan(FOLDER_MAX_DEPTH);
  });

  it('treats a missing row as a root rather than truncating silently mid-chain', async () => {
    // Impossible under the foreign key; asserted so that if the constraint is
    // ever dropped, the behaviour is the documented one.
    expect(await ancestryOf('orphan', table([{ id: 'orphan', parentId: 'gone' }]))).toEqual([
      'orphan',
      'gone',
    ]);
  });
});

describe('assertFolderMove', () => {
  it('allows a root folder to move under another root', () => {
    expect(() => assertFolderMove('mover', ['root'])).not.toThrow();
    expect(depthUnder(['root'])).toBe(2);
  });

  it('refuses a folder moved inside itself', () => {
    expect(() => assertFolderMove('mover', ['mover'])).toThrow(/inside itself/u);
  });

  it('refuses the two-node cycle the database CHECK cannot see', () => {
    // CHECK (id <> parent_id) stops a -> a. It cannot stop a -> b -> a, which
    // needs two rows, and Postgres has no cheap single-table way to say so.
    expect(() => assertFolderMove('a', ['b', 'a'])).toThrow(/inside itself/u);
  });

  it('refuses a move that would nest deeper than the product offers', () => {
    let thrown: unknown;
    try {
      assertFolderMove('mover', ['child', 'root']);
    } catch (error) {
      thrown = error;
    }
    expect(isDomainError(thrown) && thrown.code).toBe('INVALID');
    expect(depthUnder(['child', 'root'])).toBe(FOLDER_MAX_DEPTH + 1);
  });

  it('allows the deepest legal move and refuses the next one, at the exact boundary', () => {
    const legal = Array.from({ length: FOLDER_MAX_DEPTH - 1 }, (_unused, index) => `a${index}`);
    expect(() => assertFolderMove('mover', legal)).not.toThrow();
    expect(() => assertFolderMove('mover', [...legal, 'one-too-many'])).toThrow();
  });
});
