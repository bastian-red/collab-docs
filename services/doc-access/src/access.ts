/**
 * Who may do what to a document.
 *
 * One function answers this for both enforcement points -- `apps/api`'s guards
 * and `apps/sync`'s handshake -- which is the whole reason it lives in a service
 * with no framework in it. See docs/SPECS.md sections 4.1 and 4.2.
 */
import { DomainError, can, strongest, type Action, type Role } from '@docs/shared';

import { resolveShareLink, type ShareLinkRow, type ShareRefusal } from './share-links';

/** The two ways a person reaches a document. Either may be absent; both may be present. */
export interface AccessInputs {
  /** The caller's row in `document_members`, or null when they are not a member. */
  readonly membership: Role | null;
  /** The link they arrived with, if any. Not "the link that exists" -- the one they presented. */
  readonly shareLink?: ShareLinkRow | null;
  /** Present only when a link was presented, so an absent link is not read as a refused one. */
  readonly presentedToken?: string | null;
}

export type AccessSource = 'membership' | 'share-link' | 'both';

export interface Access {
  readonly role: Role;
  readonly source: AccessSource;
}

export interface AccessDenial {
  /**
   * `null` when nothing was presented at all. The caller logs this and never
   * sends it (SPECS 4.1 step 5).
   */
  readonly linkRefusal: ShareRefusal | null;
}

export type AccessOutcome =
  | { readonly ok: true; readonly access: Access }
  | { readonly ok: false; readonly denial: AccessDenial };

/**
 * The effective role, taking the stronger of membership and link.
 *
 * Stronger, not "the one they used": an editor who opens a view-only link is
 * still an editor, and silently demoting them looks exactly like data loss to
 * the person it happens to. The reverse -- a viewer who is handed an edit link
 * -- is the entire point of the feature.
 */
export function resolveAccess(documentId: string, inputs: AccessInputs, now: Date): AccessOutcome {
  const presented = inputs.presentedToken != null && inputs.presentedToken.length > 0;
  const verdict = presented ? resolveShareLink(inputs.shareLink, documentId, now) : null;
  const linkRole = verdict?.ok === true ? verdict.role : null;

  if (inputs.membership !== null && linkRole !== null) {
    return { ok: true, access: { role: strongest(inputs.membership, linkRole), source: 'both' } };
  }
  if (inputs.membership !== null) {
    return { ok: true, access: { role: inputs.membership, source: 'membership' } };
  }
  if (linkRole !== null) {
    return { ok: true, access: { role: linkRole, source: 'share-link' } };
  }
  return { ok: false, denial: { linkRefusal: verdict?.ok === false ? verdict.reason : null } };
}

/**
 * Throw unless the access permits the action.
 *
 * Two different errors on purpose, and the difference is the security property:
 *
 * - No access at all is `NOT_FOUND`. A caller who is not on the document must
 *   not be able to tell a document that exists from one that does not, because
 *   ids are guessable enough to enumerate and "403 here, 404 there" is a
 *   directory listing.
 * - Access that is too weak is `FORBIDDEN`. This caller already knows the
 *   document exists -- they can read it -- so hiding it from them buys nothing
 *   and an editor told "not found" about a document open on their screen files
 *   a bug.
 */
export function requireAction(outcome: AccessOutcome, action: Action): Access {
  if (!outcome.ok) throw new DomainError('NOT_FOUND', 'Document not found');
  if (!can(outcome.access.role, action)) {
    throw new DomainError('FORBIDDEN', `Your role on this document cannot ${action}`);
  }
  return outcome.access;
}

/** The non-throwing form, for deciding what to render rather than what to allow. */
export function allows(outcome: AccessOutcome, action: Action): boolean {
  return outcome.ok && can(outcome.access.role, action);
}
