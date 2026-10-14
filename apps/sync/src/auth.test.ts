import type { ShareLinkRow } from '@docs/doc-access';
import { documentRoom, isDomainError, type Role, type SessionUser } from '@docs/shared';
import { mintServiceToken } from '@docs/shared/server';
import { describe, expect, it } from 'vitest';

import {
  HandshakeRefused,
  authoriseDocumentRequest,
  authoriseHandshake,
  documentIdFromRoom,
  shareTokenFrom,
  type AccessLookup,
} from './auth.js';

const SECRET = 'a-test-secret-that-is-long-enough-to-be-plausible';
const OTHER_SECRET = 'a-different-secret-of-a-similar-length-to-that';
const DOCUMENT = 'cdocsync00000000000000000';
const NOW = new Date('2026-03-09T12:00:00.000Z');
const SHARE = 'seed-share-token-view-only-not-a-secret';

const USER: SessionUser = {
  id: 'cuseriris0000000000000000',
  email: 'iris@collab.test',
  name: 'Iris Almeida',
};

function lookup(overrides: Partial<AccessLookup> = {}): AccessLookup {
  return {
    membership: async () => null,
    shareLink: async () => null,
    documentExists: async () => true,
    ...overrides,
  };
}

function link(overrides: Partial<ShareLinkRow> = {}): ShareLinkRow {
  return { documentId: DOCUMENT, role: 'VIEWER', expiresAt: null, revokedAt: null, ...overrides };
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'did not throw';
  } catch (error) {
    return error instanceof HandshakeRefused ? error.reason : `not a refusal: ${String(error)}`;
  }
}

/** The typed code a rejection carries, for the HTTP half of the decision. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'did not throw';
  } catch (error) {
    return isDomainError(error) ? error.code : `not a DomainError: ${String(error)}`;
  }
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'did not throw';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function handshake(token: string, extra: { shareToken?: string | null } = {}) {
  return { token, documentId: DOCUMENT, shareToken: extra.shareToken ?? null, now: NOW };
}

describe('authoriseHandshake', () => {
  it('admits an editor and leaves the connection writable', async () => {
    const result = await authoriseHandshake(
      handshake(mintServiceToken(USER, SECRET)),
      SECRET,
      lookup({ membership: async () => 'EDITOR' }),
    );
    expect(result.readOnly).toBe(false);
    expect(result.context).toEqual({ user: USER, role: 'EDITOR', documentId: DOCUMENT });
  });

  it('admits an owner and leaves the connection writable', async () => {
    const result = await authoriseHandshake(
      handshake(mintServiceToken(USER, SECRET)),
      SECRET,
      lookup({ membership: async () => 'OWNER' }),
    );
    expect(result.readOnly).toBe(false);
  });

  it('marks a viewer and a commenter read-only', async () => {
    // The one line the whole read-only guarantee rests on. Hocuspocus drops the
    // writes itself once this is set; what we own is this decision.
    for (const role of ['VIEWER', 'COMMENTER'] as Role[]) {
      const result = await authoriseHandshake(
        handshake(mintServiceToken(USER, SECRET)),
        SECRET,
        lookup({ membership: async () => role }),
      );
      expect(result.readOnly, role).toBe(true);
      expect(result.context.role, role).toBe(role);
    }
  });

  it('refuses a token signed with a different secret', async () => {
    expect(
      await refusalOf(
        authoriseHandshake(handshake(mintServiceToken(USER, OTHER_SECRET)), SECRET, lookup()),
      ),
    ).toBe('signature');
  });

  it('refuses an expired token', async () => {
    const stale = mintServiceToken(USER, SECRET, -1);
    expect(await refusalOf(authoriseHandshake(handshake(stale), SECRET, lookup()))).toBe('expired');
  });

  it('refuses a token that is not a token', async () => {
    expect(await refusalOf(authoriseHandshake(handshake('not.a.jwt'), SECRET, lookup()))).toBe(
      'signature',
    );
  });

  it('verifies the token before looking anything up', async () => {
    // Otherwise the response time of a refusal tells an unauthenticated caller
    // whether a document id exists, which turns a guessable id into a probe.
    let looked = 0;
    await refusalOf(
      authoriseHandshake(handshake('not.a.jwt'), SECRET, {
        membership: async () => {
          looked += 1;
          return null;
        },
        shareLink: async () => {
          looked += 1;
          return null;
        },
        documentExists: async () => {
          looked += 1;
          return true;
        },
      }),
    );
    expect(looked).toBe(0);
  });

  it('refuses an authenticated stranger, and says so only to the log', async () => {
    const refused = await refusalOf(
      authoriseHandshake(handshake(mintServiceToken(USER, SECRET)), SECRET, lookup()),
    );
    expect(refused).toBe('no-access');
  });

  it('refuses the OWNER of a soft-deleted document', async () => {
    // `document_members` rows outlive a soft delete, so the owner still has a
    // role. Deciding on the role alone let them open a deleted document, sync
    // it, and write it back into existence from an offline copy.
    const refused = await refusalOf(
      authoriseHandshake(
        handshake(mintServiceToken(USER, SECRET)),
        SECRET,
        lookup({ membership: async () => 'OWNER', documentExists: async () => false }),
      ),
    );
    expect(refused).toBe('no-document');
  });

  it('refuses a live share link to a soft-deleted document', async () => {
    const refused = await refusalOf(
      authoriseHandshake(
        handshake(mintServiceToken(USER, SECRET), { shareToken: SHARE }),
        SECRET,
        lookup({
          shareLink: async () => link({ role: 'EDITOR' }),
          documentExists: async () => false,
        }),
      ),
    );
    expect(refused).toBe('no-document');
  });

  it('distinguishes a missing document from a forbidden one, in the reason only', async () => {
    const refused = await refusalOf(
      authoriseHandshake(
        handshake(mintServiceToken(USER, SECRET)),
        SECRET,
        lookup({ documentExists: async () => false }),
      ),
    );
    expect(refused).toBe('no-document');
  });

  it('gives every refusal the same client-visible message', async () => {
    // The reason is a property, for the log. The message is what a client could
    // see, and "expired signature" tells somebody probing that the token was
    // real and the secret is right.
    const messages = new Set<string>();
    for (const [token, look] of [
      ['not.a.jwt', lookup()],
      [mintServiceToken(USER, OTHER_SECRET), lookup()],
      [mintServiceToken(USER, SECRET, -1), lookup()],
      [mintServiceToken(USER, SECRET), lookup()],
      [mintServiceToken(USER, SECRET), lookup({ documentExists: async () => false })],
    ] as Array<[string, AccessLookup]>) {
      try {
        await authoriseHandshake(handshake(token), SECRET, look);
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect([...messages]).toEqual(['Not authorised for this document']);
  });

  it('admits a stranger holding a live share link, read-only for a viewer link', async () => {
    const result = await authoriseHandshake(
      handshake(mintServiceToken(USER, SECRET), { shareToken: SHARE }),
      SECRET,
      lookup({ shareLink: async () => link() }),
    );
    expect(result.readOnly).toBe(true);
    expect(result.context.role).toBe('VIEWER');
  });

  it('lets an editor link write', async () => {
    const result = await authoriseHandshake(
      handshake(mintServiceToken(USER, SECRET), { shareToken: SHARE }),
      SECRET,
      lookup({ shareLink: async () => link({ role: 'EDITOR' }) }),
    );
    expect(result.readOnly).toBe(false);
  });

  it('refuses a revoked link, and does not fall back to nothing quietly', async () => {
    expect(
      await refusalOf(
        authoriseHandshake(
          handshake(mintServiceToken(USER, SECRET), { shareToken: SHARE }),
          SECRET,
          lookup({ shareLink: async () => link({ revokedAt: NOW }) }),
        ),
      ),
    ).toBe('no-access');
  });

  it('refuses an expired link', async () => {
    expect(
      await refusalOf(
        authoriseHandshake(
          handshake(mintServiceToken(USER, SECRET), { shareToken: SHARE }),
          SECRET,
          lookup({ shareLink: async () => link({ expiresAt: NOW }) }),
        ),
      ),
    ).toBe('no-access');
  });

  it('never demotes a member who arrived through a weaker link', async () => {
    const result = await authoriseHandshake(
      handshake(mintServiceToken(USER, SECRET), { shareToken: SHARE }),
      SECRET,
      lookup({ membership: async () => 'EDITOR', shareLink: async () => link({ role: 'VIEWER' }) }),
    );
    expect(result.readOnly).toBe(false);
    expect(result.context.role).toBe('EDITOR');
  });

  it('does not look a link up when none was presented', async () => {
    let lookups = 0;
    await authoriseHandshake(handshake(mintServiceToken(USER, SECRET)), SECRET, {
      membership: async () => 'VIEWER',
      shareLink: async () => {
        lookups += 1;
        return null;
      },
      documentExists: async () => true,
    });
    expect(lookups).toBe(0);
  });
});

/**
 * The HTTP half of the same decision.
 *
 * `/documents/:id/diff` serves the document's text and
 * `POST /documents/:id/versions` writes a row; both live on the sync server
 * because both need a `Y.Doc`. Reusing `authoriseHandshake` rather than writing
 * a second check is the point of these tests: the failure they hold shut is an
 * HTTP route with its own, weaker, idea of who may read a document.
 */
describe('authoriseDocumentRequest', () => {
  it('admits a role the action allows', async () => {
    const context = await authoriseDocumentRequest(
      handshake(mintServiceToken(USER, SECRET)),
      SECRET,
      lookup({ membership: async () => 'EDITOR' }),
      'version.create',
    );
    expect(context).toEqual({ user: USER, role: 'EDITOR', documentId: DOCUMENT });
  });

  /**
   * A commenter may READ a version and may not CUT one. That distinction is the
   * reason the matrix is written out in full rather than derived from a rank --
   * and it is the reason this function takes an action at all instead of asking
   * the handshake's single question.
   */
  it('lets a commenter read a version and refuses them cutting one', async () => {
    const admitted = await authoriseDocumentRequest(
      handshake(mintServiceToken(USER, SECRET)),
      SECRET,
      lookup({ membership: async () => 'COMMENTER' }),
      'version.read',
    );
    expect(admitted.role).toBe('COMMENTER');

    await expect(
      authoriseDocumentRequest(
        handshake(mintServiceToken(USER, SECRET)),
        SECRET,
        lookup({ membership: async () => 'COMMENTER' }),
        'version.create',
      ),
    ).rejects.toSatisfy((error: unknown) => isDomainError(error) && error.code === 'FORBIDDEN');
  });

  it('refuses a viewer cutting a version, and does not tell them the document is missing', async () => {
    // FORBIDDEN, not the handshake's blanket refusal. This caller can already
    // read the document, so "not found" would be a lie they can disprove.
    await expect(
      authoriseDocumentRequest(
        handshake(mintServiceToken(USER, SECRET)),
        SECRET,
        lookup({ membership: async () => 'VIEWER' }),
        'version.create',
      ),
    ).rejects.toSatisfy((error: unknown) => isDomainError(error) && error.code === 'FORBIDDEN');
  });

  /**
   * Everything the handshake refuses, this refuses -- because it IS the
   * handshake. Without that reuse, the diff endpoint would be a second door with
   * its own lock, and the weaker of two locks is the one that decides.
   *
   * The refusal arrives as a `DomainError` rather than a `HandshakeRefused`,
   * because over HTTP a refusal needs a status. A `HandshakeRefused` reaching
   * `http.ts` would fall through to the unclassified branch and answer 500 for
   * "you are not on this document", which reads as a server fault and gets
   * retried.
   */
  it('refuses everything the handshake refuses, as a typed code', async () => {
    const token = mintServiceToken(USER, SECRET);
    const cases: Array<[string, AccessLookup, string, string]> = [
      // Both 404, and deliberately indistinguishable: a caller must not learn
      // that a document id was real by being told they lack access to it.
      ['no role at all', lookup(), token, 'NOT_FOUND'],
      [
        'a deleted document',
        lookup({ membership: async () => 'OWNER', documentExists: async () => false }),
        token,
        'NOT_FOUND',
      ],
      // A token problem is the caller's to fix, so it says so -- without saying
      // which half of the token was wrong.
      [
        'a token from another secret',
        lookup({ membership: async () => 'OWNER' }),
        mintServiceToken(USER, OTHER_SECRET),
        'UNAUTHENTICATED',
      ],
      [
        'an expired token',
        lookup({ membership: async () => 'OWNER' }),
        mintServiceToken(USER, SECRET, -1),
        'UNAUTHENTICATED',
      ],
      [
        'a token that is not a token',
        lookup({ membership: async () => 'OWNER' }),
        'not.a.jwt',
        'UNAUTHENTICATED',
      ],
    ];

    for (const [name, access, presented, code] of cases) {
      expect(
        await codeOf(
          authoriseDocumentRequest(handshake(presented), SECRET, access, 'version.read'),
        ),
        name,
      ).toBe(code);
    }
  });

  it('never puts the refusal reason in the message', async () => {
    // `expired` versus `signature` is the one bit somebody probing has no other
    // way to learn. It goes to the log; the message is the same either way.
    const expired = await messageOf(
      authoriseDocumentRequest(
        handshake(mintServiceToken(USER, SECRET, -1)),
        SECRET,
        lookup(),
        'version.read',
      ),
    );
    const wrongSecret = await messageOf(
      authoriseDocumentRequest(
        handshake(mintServiceToken(USER, OTHER_SECRET)),
        SECRET,
        lookup(),
        'version.read',
      ),
    );
    expect(expired).toBe(wrongSecret);
  });

  it('takes the stronger of a membership and a share link, like the socket does', async () => {
    const context = await authoriseDocumentRequest(
      handshake(mintServiceToken(USER, SECRET), { shareToken: SHARE }),
      SECRET,
      lookup({ membership: async () => 'VIEWER', shareLink: async () => link({ role: 'EDITOR' }) }),
      'version.create',
    );
    expect(context.role).toBe('EDITOR');
  });
});

describe('shareTokenFrom', () => {
  it('reads the share parameter', () => {
    expect(shareTokenFrom(new URLSearchParams('share=abc'))).toBe('abc');
  });

  it('treats absent, empty and whitespace alike', () => {
    expect(shareTokenFrom(new URLSearchParams(''))).toBeNull();
    expect(shareTokenFrom(new URLSearchParams('share='))).toBeNull();
    expect(shareTokenFrom(new URLSearchParams('share=%20%20'))).toBeNull();
  });
});

describe('documentIdFromRoom', () => {
  it('accepts exactly the name the web app connects with', () => {
    // The regression test for a real drift: @docs/shared's documentRoom() once
    // prefixed `doc:`, which this parser refuses, so a client built on it would
    // have been closed on every document while every unit test stayed green.
    expect(documentIdFromRoom(documentRoom(DOCUMENT))).toBe(DOCUMENT);
  });
  it('accepts a cuid and the seed ids, which are cuid-shaped for this reason', () => {
    expect(documentIdFromRoom('clx8k2p0000008l3f4h2g9d7')).toBe('clx8k2p0000008l3f4h2g9d7');
    expect(documentIdFromRoom(DOCUMENT)).toBe(DOCUMENT);
  });

  it('refuses a room name that is not a document id', () => {
    // Hocuspocus lets a client name any room it likes, so this is where an
    // arbitrary client-supplied string becomes a database key.
    for (const bad of [
      '',
      '../etc/passwd',
      'doc id',
      'doc?query=1',
      'doc/sub',
      'x'.repeat(65),
      'doc%00',
      'seed-doc-sync',
      'CDOCSYNC00000000000000000',
      'short',
    ]) {
      let code = 'did not throw';
      try {
        documentIdFromRoom(bad);
      } catch (error) {
        code = isDomainError(error) ? error.code : 'wrong error';
      }
      expect(code, JSON.stringify(bad)).toBe('INVALID');
    }
  });
});
