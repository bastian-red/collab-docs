import { DomainError } from '@docs/shared';
import { describe, expect, it } from 'vitest';

import { afterCursor, decodeCursor, encodeCursor } from './cursor';

const AT = new Date('2026-08-26T09:30:00.000Z');
const ID = 'clq1234567890abcdefghij';

describe('cursor', () => {
  it('round-trips', () => {
    const decoded = decodeCursor(encodeCursor({ updatedAt: AT, id: ID }));
    expect(decoded.updatedAt.toISOString()).toBe(AT.toISOString());
    expect(decoded.id).toBe(ID);
  });

  // base64url, so nothing in it needs escaping in a query string. Computed, not
  // recalled: the standard alphabet would put `+` and `/` in here.
  it('is base64url and survives a query string unescaped', () => {
    const encoded = encodeCursor({ updatedAt: AT, id: ID });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  /**
   * A malformed cursor is refused rather than silently restarting the list.
   * Restarting means a client with a stale cursor pages forever and nothing
   * says why.
   */
  it('refuses a cursor it cannot read', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(DomainError);
    expect(() => decodeCursor(Buffer.from('no separator').toString('base64url'))).toThrow(
      DomainError,
    );
    expect(() => decodeCursor(Buffer.from('not-a-date|id').toString('base64url'))).toThrow(
      DomainError,
    );
    expect(() => decodeCursor(Buffer.from(`${AT.toISOString()}|`).toString('base64url'))).toThrow(
      DomainError,
    );
  });

  it('refuses rather than throwing something untyped', () => {
    try {
      decodeCursor('!!!');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as DomainError).code).toBe('INVALID');
    }
  });

  /**
   * The classic keyset bug lives in the second branch. Without it, two documents
   * saved in the same millisecond are a page boundary that either drops one or
   * returns it on every page.
   */
  it('breaks a timestamp tie by id', () => {
    const filter = afterCursor({ updatedAt: AT, id: ID });
    expect(filter.OR[0]).toEqual({ updatedAt: { lt: AT } });
    expect(filter.OR[1]).toEqual({ updatedAt: AT, id: { gt: ID } });
  });
});
