/**
 * Folder moves: the two ways a tree stored in a self-referencing column goes
 * wrong, and the cap that keeps the product's shape.
 *
 * `CHECK ("id" <> "parent_id")` stops the one-node cycle in the database. It
 * cannot stop A -> B -> A, because that needs two rows and Postgres has no
 * cheap way to express "no cycles" over a single table. So it is refused here,
 * before the UPDATE, and the walk that checks it is itself bounded (SPECS 3.5).
 */
import { DomainError } from '@docs/shared';

/**
 * Root folder = depth 1, a folder inside it = depth 2. That is the whole tree
 * the product offers (SPECS 1.1: "folders one level deep").
 *
 * The column allows a deeper tree deliberately: making the schema express the
 * product's current depth would mean a migration to change a product decision.
 */
export const FOLDER_MAX_DEPTH = 2;

/**
 * How far an ancestry walk may go before it is treated as broken.
 *
 * Strictly larger than `FOLDER_MAX_DEPTH`, because the walk has to be able to
 * observe a chain that is one too long in order to refuse it. Reaching this
 * limit does not mean a deep tree, it means a cycle already in the table: the
 * loop terminates and reports rather than spinning a request thread forever.
 */
export const FOLDER_ANCESTRY_LIMIT = 32;

export interface FolderRow {
  readonly id: string;
  readonly parentId: string | null;
}

/**
 * The chain from `folderId` up to a root, nearest first, including `folderId`.
 *
 * `lookup` returns null for an id that is not there, which ends the walk: a
 * dangling `parent_id` is impossible under the foreign key, so treating it as a
 * root is safe rather than a silent truncation of a real chain.
 */
export async function ancestryOf(
  folderId: string,
  lookup: (id: string) => Promise<FolderRow | null>,
): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;

  while (current !== null) {
    if (seen.has(current)) {
      // Already-cyclic data. Refusing here rather than returning a partial chain
      // keeps a corrupted row from being read as a shallow, movable folder.
      throw new DomainError('CONFLICT', 'Folder ancestry contains a cycle');
    }
    if (chain.length >= FOLDER_ANCESTRY_LIMIT) {
      throw new DomainError('CONFLICT', 'Folder ancestry is longer than the tree allows');
    }
    seen.add(current);
    chain.push(current);
    const row: FolderRow | null = await lookup(current);
    current = row?.parentId ?? null;
  }

  return chain;
}

/**
 * Whether moving `folderId` under `parentAncestry` is legal.
 *
 * `parentAncestry` is `ancestryOf(newParentId)`: nearest first, including the
 * new parent. Passing the chain in rather than the id keeps this function pure
 * and synchronous, so the whole rule is testable without a database and the one
 * I/O call sits at the call site where its transaction is.
 */
export function assertFolderMove(folderId: string, parentAncestry: readonly string[]): void {
  if (parentAncestry.includes(folderId)) {
    // Includes the self-move (`parentAncestry[0] === folderId`), which the CHECK
    // would also catch, and A -> B -> A, which it would not.
    throw new DomainError('INVALID', 'A folder cannot be moved inside itself');
  }
  if (parentAncestry.length + 1 > FOLDER_MAX_DEPTH) {
    throw new DomainError('INVALID', `Folders nest ${FOLDER_MAX_DEPTH} levels deep at most`);
  }
}

/** The depth a folder would sit at, given its prospective parent's ancestry. */
export function depthUnder(parentAncestry: readonly string[]): number {
  return parentAncestry.length + 1;
}
