/**
 * What a share link is worth, right now.
 *
 * Pure: it takes the row and the clock and returns a verdict. The lookup by
 * token belongs to the caller, because the two callers look it up differently
 * (`apps/api` inside the request transaction, `apps/sync` during the handshake)
 * and neither of them should own the expiry rule.
 *
 * See docs/SPECS.md section 4.1 step 4.
 */
import { SHARE_ROLES, type Role, type ShareableRole } from '@docs/shared';

/**
 * The columns of `share_links` this decision reads, and no others.
 *
 * Declared structurally rather than imported from `@docs/db`, so this package
 * has no dependency on Prisma and its tests need no database. The Prisma row
 * satisfies it by shape.
 */
export interface ShareLinkRow {
  readonly documentId: string;
  readonly role: Role;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * Why a link was refused.
 *
 * Kept apart from the yes/no because the caller has to log it and must not send
 * it: telling a holder "expired" rather than "unknown" tells them the token was
 * real, which is the one bit a guesser wants. `apps/sync` closes with one
 * reason for all four (SPECS 4.1 step 5); `apps/api` answers `GONE` for all
 * four.
 */
export type ShareRefusal = 'unknown' | 'wrong-document' | 'revoked' | 'expired' | 'not-shareable';

export type ShareLinkVerdict =
  | { readonly ok: true; readonly role: ShareableRole }
  | { readonly ok: false; readonly reason: ShareRefusal };

const SHAREABLE = new Set<Role>(SHARE_ROLES);

/**
 * Resolve a link against the document it was presented for.
 *
 * `documentId` is passed in and checked rather than trusted from the row: a
 * token is a bearer credential pasted into a URL beside a document id, and
 * without this check a valid link for document A is a valid link for document B.
 *
 * The expiry comparison is `<=`, not `<`. A link that expires at exactly `now`
 * is expired. The other way round leaves a one-millisecond window whose
 * behaviour depends on clock resolution, which is the kind of thing that passes
 * every test and fails once a year.
 */
export function resolveShareLink(
  link: ShareLinkRow | null | undefined,
  documentId: string,
  now: Date,
): ShareLinkVerdict {
  if (!link) return { ok: false, reason: 'unknown' };
  if (link.documentId !== documentId) return { ok: false, reason: 'wrong-document' };
  if (link.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  // Defence in depth, and the third copy of this rule: `SHARE_ROLES` excludes
  // OWNER, `CHECK ("role" <> 'OWNER')` refuses the INSERT, and this refuses a
  // row that reached the table some other way -- a manual UPDATE, a restored
  // dump, a future migration that adds a role and forgets the check. A link is
  // forwardable; a forwardable link that hands over the document is how somebody
  // loses one.
  if (!SHAREABLE.has(link.role)) return { ok: false, reason: 'not-shareable' };
  return { ok: true, role: link.role as ShareableRole };
}

/** Whether a link would still be accepted, for rendering a list of them. */
export function isLive(link: ShareLinkRow, now: Date): boolean {
  return resolveShareLink(link, link.documentId, now).ok;
}

/**
 * The absolute expiry for a TTL expressed in hours, or null for a link that
 * never expires.
 *
 * Here rather than in the API so "expires in 24 hours" means the same instant to
 * everything that computes it, and so the arithmetic is covered by a test rather
 * than repeated at three call sites.
 */
export function expiryFor(ttlHours: number | null, now: Date): Date | null {
  if (ttlHours === null) return null;
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
}
