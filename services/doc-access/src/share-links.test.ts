import { ROLES, SHARE_ROLES, type Role } from '@docs/shared';
import { describe, expect, it } from 'vitest';

import { expiryFor, isLive, resolveShareLink, type ShareLinkRow } from './share-links';

const DOCUMENT = 'doc_9f3c';
const NOW = new Date('2026-03-09T12:00:00.000Z');

function link(overrides: Partial<ShareLinkRow> = {}): ShareLinkRow {
  return {
    documentId: DOCUMENT,
    role: 'EDITOR',
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('resolveShareLink', () => {
  it('accepts a live link and reports the role it carries', () => {
    expect(resolveShareLink(link({ role: 'VIEWER' }), DOCUMENT, NOW)).toEqual({
      ok: true,
      role: 'VIEWER',
    });
  });

  it('refuses a token that matched nothing', () => {
    expect(resolveShareLink(null, DOCUMENT, NOW)).toEqual({ ok: false, reason: 'unknown' });
    expect(resolveShareLink(undefined, DOCUMENT, NOW)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('refuses a link for a different document', () => {
    // Without this the token is a credential for the whole table: a link to a
    // document you are allowed to see opens one you are not, by editing the id
    // in the URL and keeping the token.
    expect(resolveShareLink(link(), 'doc_other', NOW)).toEqual({
      ok: false,
      reason: 'wrong-document',
    });
  });

  it('refuses a revoked link even when it has not expired', () => {
    const revoked = link({ revokedAt: new Date('2026-03-09T11:59:59.000Z'), expiresAt: null });
    expect(resolveShareLink(revoked, DOCUMENT, NOW)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses a link whose expiry has passed', () => {
    const expired = link({ expiresAt: new Date('2026-03-09T11:59:59.999Z') });
    expect(resolveShareLink(expired, DOCUMENT, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('treats the instant of expiry as expired, not as the last live millisecond', () => {
    // `<=`, not `<`. The other way round leaves a window whose width is the
    // clock's resolution, which passes every test and surprises somebody once.
    expect(resolveShareLink(link({ expiresAt: NOW }), DOCUMENT, NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      resolveShareLink(link({ expiresAt: new Date(NOW.getTime() + 1) }), DOCUMENT, NOW).ok,
    ).toBe(true);
  });

  it('never returns OWNER, whatever the row says', () => {
    // The row cannot say OWNER: `SHARE_ROLES` excludes it and
    // `CHECK ("role" <> 'OWNER')` refuses the INSERT. This is the third copy,
    // for a row that arrived by a restored dump or a hand-written UPDATE.
    const forged = { ...link(), role: 'OWNER' as Role };
    expect(resolveShareLink(forged, DOCUMENT, NOW)).toEqual({ ok: false, reason: 'not-shareable' });
  });

  it('accepts every role a link is allowed to carry', () => {
    // Exhaustive over SHARE_ROLES rather than three examples, so a role added to
    // the matrix is either accepted here or fails this test.
    for (const role of SHARE_ROLES) {
      expect(resolveShareLink(link({ role }), DOCUMENT, NOW)).toEqual({ ok: true, role });
    }
    expect(SHARE_ROLES.length).toBe(ROLES.length - 1);
  });

  it('checks revocation before expiry, so a revoked link never reads as merely stale', () => {
    const both = link({ revokedAt: NOW, expiresAt: new Date('2026-03-01T00:00:00.000Z') });
    expect(resolveShareLink(both, DOCUMENT, NOW)).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('isLive', () => {
  it('is the same answer as resolveShareLink, for rendering a list', () => {
    expect(isLive(link(), NOW)).toBe(true);
    expect(isLive(link({ revokedAt: NOW }), NOW)).toBe(false);
  });
});

describe('expiryFor', () => {
  it('is null for a link that never expires', () => {
    expect(expiryFor(null, NOW)).toBeNull();
  });

  it('adds whole hours', () => {
    expect(expiryFor(24, NOW)?.toISOString()).toBe('2026-03-10T12:00:00.000Z');
  });

  it('produces an instant the resolver then treats as live until it passes', () => {
    const expiresAt = expiryFor(1, NOW)!;
    const oneMsBefore = new Date(expiresAt.getTime() - 1);
    expect(resolveShareLink(link({ expiresAt }), DOCUMENT, oneMsBefore).ok).toBe(true);
    expect(resolveShareLink(link({ expiresAt }), DOCUMENT, expiresAt).ok).toBe(false);
  });
});
