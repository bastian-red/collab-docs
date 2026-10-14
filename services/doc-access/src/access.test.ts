import { ACTIONS, ROLES, can, isDomainError, type Role } from '@docs/shared';
import { describe, expect, it } from 'vitest';

import { allows, requireAction, resolveAccess, type AccessOutcome } from './access';
import type { ShareLinkRow } from './share-links';

const DOCUMENT = 'doc_9f3c';
const NOW = new Date('2026-03-09T12:00:00.000Z');
// Readable on purpose, and low entropy on purpose. A realistic-looking 43-char
// base64url fixture is indistinguishable from a real share token to gitleaks,
// which flags it -- and the fix for that must never be an allowlist entry for a
// high-entropy literal, because that is the same entry a real leak would hide
// behind. Nothing here depends on the value: `resolveAccess` only asks whether a
// token was presented at all.
const TOKEN = 'share-token-fixture-not-a-secret';

function link(overrides: Partial<ShareLinkRow> = {}): ShareLinkRow {
  return { documentId: DOCUMENT, role: 'EDITOR', expiresAt: null, revokedAt: null, ...overrides };
}

function codeOf(thrown: unknown): string {
  return isDomainError(thrown) ? thrown.code : `not a DomainError: ${String(thrown)}`;
}

describe('resolveAccess', () => {
  it('gives a member their own role when no link was presented', () => {
    const outcome = resolveAccess(DOCUMENT, { membership: 'EDITOR' }, NOW);
    expect(outcome).toEqual({ ok: true, access: { role: 'EDITOR', source: 'membership' } });
  });

  it('gives a stranger the link role', () => {
    const outcome = resolveAccess(
      DOCUMENT,
      { membership: null, shareLink: link({ role: 'VIEWER' }), presentedToken: TOKEN },
      NOW,
    );
    expect(outcome).toEqual({ ok: true, access: { role: 'VIEWER', source: 'share-link' } });
  });

  it('never demotes a member who arrived through a weaker link', () => {
    // The bug this holds shut: an editor opens the view-only link a colleague
    // pasted in chat, and the editor they were becomes a viewer. To that person
    // the document just went read-only for no reason they can see.
    const outcome = resolveAccess(
      DOCUMENT,
      { membership: 'EDITOR', shareLink: link({ role: 'VIEWER' }), presentedToken: TOKEN },
      NOW,
    );
    expect(outcome).toEqual({ ok: true, access: { role: 'EDITOR', source: 'both' } });
  });

  it('promotes a weak member through a stronger link, which is the point of the feature', () => {
    const outcome = resolveAccess(
      DOCUMENT,
      { membership: 'VIEWER', shareLink: link({ role: 'EDITOR' }), presentedToken: TOKEN },
      NOW,
    );
    expect(outcome).toEqual({ ok: true, access: { role: 'EDITOR', source: 'both' } });
  });

  it('falls back to membership when the presented link is dead', () => {
    const outcome = resolveAccess(
      DOCUMENT,
      { membership: 'VIEWER', shareLink: link({ revokedAt: NOW }), presentedToken: TOKEN },
      NOW,
    );
    expect(outcome).toEqual({ ok: true, access: { role: 'VIEWER', source: 'membership' } });
  });

  it('refuses a stranger with nothing, and reports no link refusal', () => {
    const outcome = resolveAccess(DOCUMENT, { membership: null }, NOW);
    expect(outcome).toEqual({ ok: false, denial: { linkRefusal: null } });
  });

  it('carries the refusal reason for the log, separately from the answer', () => {
    const outcome = resolveAccess(
      DOCUMENT,
      {
        membership: null,
        shareLink: link({ expiresAt: new Date('2026-03-01T00:00:00.000Z') }),
        presentedToken: TOKEN,
      },
      NOW,
    );
    expect(outcome).toEqual({ ok: false, denial: { linkRefusal: 'expired' } });
  });

  it('ignores a link row when no token was presented', () => {
    // A caller who loads the document's links for the sharing panel must not
    // accidentally authenticate themselves with one of them.
    const outcome = resolveAccess(DOCUMENT, { membership: null, shareLink: link() }, NOW);
    expect(outcome).toEqual({ ok: false, denial: { linkRefusal: null } });
  });

  it('treats an empty token string as no token', () => {
    const outcome = resolveAccess(
      DOCUMENT,
      { membership: null, shareLink: link(), presentedToken: '' },
      NOW,
    );
    expect(outcome).toEqual({ ok: false, denial: { linkRefusal: null } });
  });

  it('refuses a valid token presented for the wrong document', () => {
    const outcome = resolveAccess(
      'doc_other',
      { membership: null, shareLink: link(), presentedToken: TOKEN },
      NOW,
    );
    expect(outcome).toEqual({ ok: false, denial: { linkRefusal: 'wrong-document' } });
  });
});

describe('requireAction', () => {
  function member(role: Role): AccessOutcome {
    return resolveAccess(DOCUMENT, { membership: role }, NOW);
  }

  it('agrees with the matrix for every role and every action', () => {
    // Exhaustive rather than by example: the enforcement point is bound to the
    // matrix, so a role gaining an action needs one edit, in @docs/shared, and
    // this test follows it. A copied list here would be a second matrix that
    // drifts.
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        const outcome = member(role);
        if (can(role, action)) {
          expect(requireAction(outcome, action).role).toBe(role);
          expect(allows(outcome, action)).toBe(true);
        } else {
          expect(() => requireAction(outcome, action)).toThrow();
          expect(allows(outcome, action)).toBe(false);
        }
      }
    }
  });

  it('answers NOT_FOUND to a caller with no access, so ids cannot be enumerated', () => {
    // FORBIDDEN here would separate "this document exists" from "it does not",
    // which turns a guessable id into a directory listing.
    let thrown: unknown;
    try {
      requireAction(resolveAccess(DOCUMENT, { membership: null }, NOW), 'document.read');
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('NOT_FOUND');
  });

  it('answers FORBIDDEN to a caller whose role is too weak', () => {
    // This caller can already see the document, so hiding it buys nothing, and
    // "not found" about a document open on screen reads as a bug.
    let thrown: unknown;
    try {
      requireAction(member('VIEWER'), 'document.write');
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('FORBIDDEN');
  });

  it('lets a share-link editor write, because the source of the role does not change it', () => {
    const outcome = resolveAccess(
      DOCUMENT,
      { membership: null, shareLink: link({ role: 'EDITOR' }), presentedToken: TOKEN },
      NOW,
    );
    expect(requireAction(outcome, 'document.write')).toEqual({
      role: 'EDITOR',
      source: 'share-link',
    });
  });

  it('never lets a link holder reach an owner-only action', () => {
    for (const outcome of [
      resolveAccess(
        DOCUMENT,
        { membership: null, shareLink: link({ role: 'EDITOR' }), presentedToken: TOKEN },
        NOW,
      ),
      resolveAccess(
        DOCUMENT,
        { membership: null, shareLink: link({ role: 'VIEWER' }), presentedToken: TOKEN },
        NOW,
      ),
    ]) {
      expect(allows(outcome, 'document.delete')).toBe(false);
      expect(allows(outcome, 'member.write')).toBe(false);
      expect(allows(outcome, 'link.write')).toBe(false);
    }
  });
});
