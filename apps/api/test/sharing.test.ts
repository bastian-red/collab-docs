/**
 * Members, ownership transfer, and share links.
 *
 * The invariant that no constraint can carry on its own is here:
 * `document_members_one_owner` is a PARTIAL unique index, so the database
 * refuses a SECOND owner and has no way to refuse ZERO. Every path that could
 * leave a document ownerless is closed in `MembersService`, and only a real
 * transaction against a real index proves it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  IRIS,
  MARA,
  THEO,
  boot,
  call,
  createDocument,
  loadSeedUsers,
  removeDocuments,
  uniqueTitle,
  type Harness,
} from './support.js';

let harness: Harness;
const created: string[] = [];

beforeAll(async () => {
  harness = await boot();
  await loadSeedUsers(harness.db);
});

afterAll(async () => {
  await removeDocuments(harness.db, created);
  await harness.close();
});

async function document(title: string): Promise<string> {
  const id = await createDocument(harness, IRIS, title);
  created.push(id);
  return id;
}

describe('members', () => {
  it('invites by email and never says whether an address has an account', async () => {
    const id = await document(uniqueTitle('Invite'));

    const invited = await call<{ id: string; name: string; role: string }>(
      harness,
      'POST',
      `/documents/${id}/members`,
      { user: IRIS, body: { email: THEO.email, role: 'EDITOR' } },
    );
    expect(invited.status).toBe(201);
    expect(invited.body).toEqual({ id: THEO.id, name: THEO.name, role: 'EDITOR' });

    const unknown = await call(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: 'nobody-at-all@collab.test', role: 'EDITOR' },
    });
    expect(unknown.status).toBe(404);
  });

  it('changes the role of somebody already there rather than answering 409', async () => {
    const id = await document(uniqueTitle('Reinvite'));
    await call(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: THEO.email, role: 'VIEWER' },
    });
    const again = await call<{ role: string }>(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: THEO.email, role: 'EDITOR' },
    });
    expect(again.status).toBe(201);
    expect(again.body.role).toBe('EDITOR');
  });

  /**
   * An invitation can never be a transfer. `inviteMemberSchema` carries
   * `shareRoleSchema`, which is `ROLES` minus OWNER -- so the request is refused
   * at the contract, before any code has to decide what it would mean.
   */
  it('refuses an invitation that names OWNER', async () => {
    const id = await document(uniqueTitle('No transfer by invite'));
    const reply = await call(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: THEO.email, role: 'OWNER' },
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ code: 'INVALID', fields: ['role'] });
  });

  /**
   * Two rows change and they change together. In the other order the partial
   * unique index refuses the promotion, and outside a transaction the demotion
   * would already have committed -- leaving the document with no owner at all.
   */
  it('transfers ownership atomically, demoting the old owner in the same breath', async () => {
    const id = await document(uniqueTitle('Transfer'));
    await call(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: THEO.email, role: 'VIEWER' },
    });

    const after = await call<Array<{ id: string; role: string }>>(
      harness,
      'PUT',
      `/documents/${id}/members`,
      {
        user: IRIS,
        body: { userId: THEO.id, role: 'OWNER' },
      },
    );
    expect(after.status).toBe(200);

    const roles = Object.fromEntries(after.body.map((member) => [member.id, member.role]));
    expect(roles[THEO.id]).toBe('OWNER');
    expect(roles[IRIS.id]).toBe('EDITOR');

    const owners = await harness.db.documentMember.count({
      where: { documentId: id, role: 'OWNER' },
    });
    expect(owners).toBe(1);

    // And the new owner really is one: the old owner can no longer transfer.
    const byOldOwner = await call(harness, 'PUT', `/documents/${id}/members`, {
      user: IRIS,
      body: { userId: IRIS.id, role: 'OWNER' },
    });
    expect(byOldOwner.status).toBe(403);
  });

  it('refuses demoting or removing the only owner', async () => {
    const id = await document(uniqueTitle('Ownerless'));

    const demote = await call(harness, 'PUT', `/documents/${id}/members`, {
      user: IRIS,
      body: { userId: IRIS.id, role: 'EDITOR' },
    });
    expect(demote.status).toBe(409);
    expect(demote.body).toMatchObject({ code: 'CONFLICT' });

    const remove = await call(harness, 'DELETE', `/documents/${id}/members/${IRIS.id}`, {
      user: IRIS,
    });
    expect(remove.status).toBe(409);

    expect(
      await harness.db.documentMember.count({ where: { documentId: id, role: 'OWNER' } }),
    ).toBe(1);
  });

  /**
   * Leaving is not an administrative act. A viewer has no `member.write`, so
   * without the self-removal branch a document somebody shared with them would
   * sit in their sidebar forever with no way out.
   */
  it('lets a viewer leave, and not remove anybody else', async () => {
    const id = await document(uniqueTitle('Leaving'));
    await call(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: MARA.email, role: 'VIEWER' },
    });
    await call(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: THEO.email, role: 'EDITOR' },
    });

    const removeSomebodyElse = await call(
      harness,
      'DELETE',
      `/documents/${id}/members/${THEO.id}`,
      {
        user: MARA,
      },
    );
    expect(removeSomebodyElse.status).toBe(403);

    const leave = await call(harness, 'DELETE', `/documents/${id}/members/${MARA.id}`, {
      user: MARA,
    });
    expect(leave.status).toBe(200);
    // And the document is gone from their world entirely.
    expect((await call(harness, 'GET', `/documents/${id}`, { user: MARA })).status).toBe(404);
  });

  it('lets a commenter see who else is on the document', async () => {
    // `member.read` reaches COMMENTER, which is what makes a participants list
    // mean anything to somebody holding a commenting link.
    const id = await document(uniqueTitle('Roster'));
    await call(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: MARA.email, role: 'COMMENTER' },
    });
    const reply = await call<Array<{ id: string }>>(harness, 'GET', `/documents/${id}/members`, {
      user: MARA,
    });
    expect(reply.status).toBe(200);
    expect(reply.body.map((member) => member.id).sort()).toEqual([IRIS.id, MARA.id].sort());
  });
});

describe('share links', () => {
  it('mints a link with the default TTL and a URL built on APP_BASE_URL', async () => {
    const id = await document(uniqueTitle('Link'));
    const ttlHours = Number(process.env.SHARE_LINK_TTL_HOURS ?? '168');

    const before = Date.now();
    const link = await call<{ token: string; url: string; expiresAt: string; role: string }>(
      harness,
      'POST',
      `/documents/${id}/links`,
      { user: IRIS, body: { role: 'VIEWER' } },
    );
    expect(link.status).toBe(201);
    expect(link.body.role).toBe('VIEWER');

    const expires = Date.parse(link.body.expiresAt);
    const expected = before + ttlHours * 60 * 60 * 1000;
    // Within a minute of the computed instant. A tighter bound would be
    // measuring the round trip rather than the TTL.
    expect(Math.abs(expires - expected)).toBeLessThan(60_000);

    // Asserted structurally rather than against a string built the same way the
    // API builds it, which would only prove the test and the code agree with
    // themselves.
    const url = new URL(link.body.url);
    expect(url.origin).toBe(new URL(String(process.env.APP_BASE_URL)).origin);
    expect(url.pathname).toBe(`/d/${id}`);
    expect(url.searchParams.get('share')).toBe(link.body.token);
  });

  it('honours a null TTL as a link that never expires', async () => {
    const id = await document(uniqueTitle('Forever'));
    const link = await call<{ expiresAt: string | null }>(
      harness,
      'POST',
      `/documents/${id}/links`,
      {
        user: IRIS,
        body: { role: 'VIEWER', ttlHours: null },
      },
    );
    expect(link.status).toBe(201);
    expect(link.body.expiresAt).toBeNull();
  });

  it('refuses a link that would carry OWNER, at the contract', async () => {
    const id = await document(uniqueTitle('No ownership by link'));
    const reply = await call(harness, 'POST', `/documents/${id}/links`, {
      user: IRIS,
      body: { role: 'OWNER', ttlHours: 24 },
    });
    expect(reply.status).toBe(400);
  });

  it('resolves a live link to its document and role', async () => {
    const id = await document(uniqueTitle('Resolve'));
    const link = await call<{ token: string }>(harness, 'POST', `/documents/${id}/links`, {
      user: IRIS,
      body: { role: 'COMMENTER', ttlHours: 24 },
    });

    const resolved = await call<{ documentId: string; role: string }>(
      harness,
      'GET',
      `/share/${link.body.token}`,
      { user: THEO },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ documentId: id, role: 'COMMENTER' });
  });

  it('lets a link holder read the document they were not invited to', async () => {
    const id = await document(uniqueTitle('By link'));
    const link = await call<{ token: string }>(harness, 'POST', `/documents/${id}/links`, {
      user: IRIS,
      body: { role: 'VIEWER', ttlHours: 24 },
    });

    const withoutLink = await call(harness, 'GET', `/documents/${id}`, { user: THEO });
    expect(withoutLink.status).toBe(404);

    const withLink = await call<{ role: string }>(
      harness,
      'GET',
      `/documents/${id}?share=${link.body.token}`,
      { user: THEO },
    );
    expect(withLink.status).toBe(200);
    expect(withLink.body.role).toBe('VIEWER');
  });

  /**
   * The stronger of the two, never the one they arrived with. An editor who
   * opens a view-only link is still an editor, and demoting them would look
   * exactly like data loss to the person it happened to.
   */
  it('takes the stronger of a membership and a link', async () => {
    const id = await document(uniqueTitle('Stronger'));
    await call(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: THEO.email, role: 'EDITOR' },
    });
    const link = await call<{ token: string }>(harness, 'POST', `/documents/${id}/links`, {
      user: IRIS,
      body: { role: 'VIEWER', ttlHours: 24 },
    });

    const reply = await call<{ role: string }>(
      harness,
      'GET',
      `/documents/${id}?share=${link.body.token}`,
      { user: THEO },
    );
    expect(reply.body.role).toBe('EDITOR');
  });

  /**
   * Four ways of being no good, one answer. Distinguishing them tells a guesser
   * which tokens were real, which is the one bit they cannot get any other way.
   */
  it('answers every refused link identically', async () => {
    const id = await document(uniqueTitle('Refusals'));
    const other = await document(uniqueTitle('Another document'));

    const live = await call<{ id: string; token: string }>(
      harness,
      'POST',
      `/documents/${id}/links`,
      {
        user: IRIS,
        body: { role: 'VIEWER', ttlHours: 24 },
      },
    );
    const revoked = await call<{ id: string; token: string }>(
      harness,
      'POST',
      `/documents/${id}/links`,
      { user: IRIS, body: { role: 'VIEWER', ttlHours: 24 } },
    );
    await call(harness, 'POST', `/documents/${id}/links/${revoked.body.id}/revoke`, { user: IRIS });

    const expiredRow = await harness.db.shareLink.create({
      data: {
        documentId: id,
        token: 'expired000000000000000000000000000000000000',
        role: 'VIEWER',
        expiresAt: new Date(Date.now() - 1000),
        createdById: IRIS.id,
      },
      select: { token: true },
    });

    const bodies: unknown[] = [];
    for (const token of [
      'unknown000000000000000000000000000000000000',
      revoked.body.token,
      expiredRow.token,
    ]) {
      const reply = await call(harness, 'GET', `/share/${token}`, { user: THEO });
      expect(reply.status, token).toBe(410);
      bodies.push(reply.body);
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);

    // A live link presented for the WRONG document is refused by the socket
    // handshake, not here -- resolving is how a caller learns which document a
    // token belongs to. What must not happen is the link reaching the other
    // document.
    const wrongDocument = await call<{ documentId: string }>(
      harness,
      'GET',
      `/documents/${other}?share=${live.body.token}`,
      { user: THEO },
    );
    expect(wrongDocument.status).toBe(404);
  });

  it('revokes idempotently, keeping the first instant', async () => {
    const id = await document(uniqueTitle('Revoke twice'));
    const link = await call<{ id: string }>(harness, 'POST', `/documents/${id}/links`, {
      user: IRIS,
      body: { role: 'VIEWER', ttlHours: 24 },
    });

    const first = await call<{ revokedAt: string }>(
      harness,
      'POST',
      `/documents/${id}/links/${link.body.id}/revoke`,
      { user: IRIS },
    );
    const second = await call<{ revokedAt: string }>(
      harness,
      'POST',
      `/documents/${id}/links/${link.body.id}/revoke`,
      { user: IRIS },
    );
    expect(first.status).toBe(201);
    expect(second.body.revokedAt).toBe(first.body.revokedAt);
  });

  it('refuses revoking a link that belongs to another document', async () => {
    // Without the document scope, a link id from anywhere could be revoked by
    // anybody who owns any document at all.
    const mine = await document(uniqueTitle('Mine'));
    const theirs = await document(uniqueTitle('Theirs'));
    const link = await call<{ id: string }>(harness, 'POST', `/documents/${theirs}/links`, {
      user: IRIS,
      body: { role: 'VIEWER', ttlHours: 24 },
    });

    const reply = await call(harness, 'POST', `/documents/${mine}/links/${link.body.id}/revoke`, {
      user: IRIS,
    });
    expect(reply.status).toBe(404);
  });

  it('refuses a link on a document a caller can only read', async () => {
    const id = await document(uniqueTitle('Not yours to share'));
    await call(harness, 'POST', `/documents/${id}/members`, {
      user: IRIS,
      body: { email: THEO.email, role: 'EDITOR' },
    });
    // `link.write` is OWNER only. An editor may see the links and not mint one.
    expect((await call(harness, 'GET', `/documents/${id}/links`, { user: THEO })).status).toBe(200);
    expect(
      (
        await call(harness, 'POST', `/documents/${id}/links`, {
          user: THEO,
          body: { role: 'VIEWER', ttlHours: 24 },
        })
      ).status,
    ).toBe(403);
  });
});
