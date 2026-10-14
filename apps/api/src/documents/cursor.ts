/**
 * Keyset pagination for the document list.
 *
 * Keyset and not `OFFSET`, because the list is ordered by `updated_at DESC` and
 * that column changes while somebody is paging: an offset of 25 into a list whose
 * head just moved skips rows and repeats others, and the person paging sees a
 * document twice and never sees another one at all.
 *
 * The cursor is `(updatedAt, id)`, not `updatedAt` alone. Two documents saved in
 * the same millisecond are not rare -- a seed writes several, and so does a bulk
 * move -- and a cursor that cannot break the tie either drops one of them or
 * loops on it forever.
 *
 * It is opaque on the wire but deliberately not encrypted: it carries a timestamp
 * and an id the caller already has. Base64url so it survives a query string
 * without escaping.
 */
import { DomainError } from '@docs/shared';

export interface Cursor {
  readonly updatedAt: Date;
  readonly id: string;
}

const SEPARATOR = '|';

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.updatedAt.toISOString()}${SEPARATOR}${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decode, or `INVALID`.
 *
 * A malformed cursor is refused rather than treated as "start from the
 * beginning". Silently restarting means a client with a stale cursor pages
 * through the list forever and nothing ever says why.
 */
export function decodeCursor(raw: string): Cursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf(SEPARATOR);
  if (separator === -1) throw new DomainError('INVALID', 'That page cursor is not readable.');

  const timestamp = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const updatedAt = new Date(timestamp);

  if (Number.isNaN(updatedAt.getTime()) || id.length === 0) {
    throw new DomainError('INVALID', 'That page cursor is not readable.');
  }
  return { updatedAt, id };
}

/**
 * The `WHERE` for "strictly after this cursor" in `(updated_at DESC, id ASC)`
 * order, as a Prisma filter.
 *
 * Written out rather than expressed as a row comparison because Prisma has no
 * tuple comparison: `(updated_at, id) < ($1, $2)` is one operator in SQL and two
 * branches here. Getting the second branch wrong is the classic keyset bug -- it
 * looks right, and it loses exactly the rows that share a timestamp.
 */
export function afterCursor(cursor: Cursor): {
  OR: [{ updatedAt: { lt: Date } }, { updatedAt: Date; id: { gt: string } }];
} {
  return {
    OR: [
      { updatedAt: { lt: cursor.updatedAt } },
      { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
    ],
  };
}
