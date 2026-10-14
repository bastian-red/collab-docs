/**
 * The security boundary, against a real server.
 *
 * A read-only role enforced in the editor is a lie: once a client is in a Yjs
 * room the protocol lets it send anything. So this file connects as a viewer and
 * sends real update messages through a real provider -- the same thing a person
 * with devtools open would do -- and asserts the document did not move.
 *
 * The assertions are deliberately made from the OTHER replica and from Postgres,
 * never from the viewer's own `Y.Doc`. The viewer's local document DOES change:
 * Yjs applies optimistically and the server's refusal is a `SyncStatus(false)`,
 * not a rollback. Asserting on the viewer's own copy would fail against a
 * correct server.
 */
import type { PrismaClient } from '@docs/db';
import type { SessionUser } from '@docs/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REPLICA_ONE,
  REPLICA_TWO,
  appendParagraph,
  connect,
  prisma,
  sleep,
  textOf,
  waitFor,
} from './support.js';

const IRIS: SessionUser = { id: '', email: 'iris@collab.test', name: 'Iris Almeida' };
const MARA: SessionUser = { id: '', email: 'mara@collab.test', name: 'Mara Villalobos' };

/** From `packages/db/prisma/seed.mts`. Fixed, and deliberately not a secret. */
const LIVE_LINK = 'seed-share-token-view-only-not-a-secret';
const REVOKED_LINK = `${LIVE_LINK}-revoked`;

let db: PrismaClient;
let documentId = '';
let deletedDocumentId = '';

beforeAll(async () => {
  db = prisma();
  documentId = (
    await db.document.findFirstOrThrow({
      where: { title: 'Sync protocol notes', deletedAt: null },
      select: { id: true },
    })
  ).id;
  deletedDocumentId = (
    await db.document.findFirstOrThrow({
      where: { title: 'Superseded draft' },
      select: { id: true },
    })
  ).id;
  for (const user of [IRIS, MARA]) {
    user.id = (
      await db.user.findUniqueOrThrow({ where: { email: user.email }, select: { id: true } })
    ).id;
  }
});

afterAll(async () => {
  await db.$disconnect();
});

async function logLength(): Promise<number> {
  return db.documentUpdate.count({ where: { documentId } });
}

describe('a VIEWER', () => {
  it('may open the document and read it', async () => {
    const viewer = await connect({ base: REPLICA_ONE, documentId, user: MARA, clientId: 51 });
    try {
      expect(textOf(viewer.doc)).toContain('A CRDT lives in memory');
    } finally {
      viewer.destroy();
    }
  });

  it('may not write, and the server drops the update rather than the editor hiding a button', async () => {
    const viewer = await connect({ base: REPLICA_ONE, documentId, user: MARA, clientId: 52 });
    const editor = await connect({ base: REPLICA_TWO, documentId, user: IRIS, clientId: 53 });
    try {
      const before = textOf(editor.doc);
      const beforeRows = await logLength();

      const forbidden = `a viewer wrote this at ${Date.now()}`;
      appendParagraph(viewer.doc, forbidden);

      // Long enough that a successful write would certainly have relayed: the
      // convergence tests above land in well under a second.
      await sleep(2000);

      expect(textOf(editor.doc), 'the other replica must not have seen it').toBe(before);
      expect(textOf(editor.doc)).not.toContain(forbidden);
      expect(await logLength(), 'nothing was appended to the log').toBe(beforeRows);

      const row = await db.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { contentText: true },
      });
      expect(row.contentText).not.toContain(forbidden);
    } finally {
      viewer.destroy();
      editor.destroy();
    }
  });

  it('does not block an editor writing at the same time', async () => {
    // The refusal must be scoped to the connection. A server that closed the
    // room, or that stopped processing after a refused message, would break
    // collaboration for everybody whenever a viewer joined.
    const viewer = await connect({ base: REPLICA_ONE, documentId, user: MARA, clientId: 54 });
    const editor = await connect({ base: REPLICA_TWO, documentId, user: IRIS, clientId: 55 });
    try {
      appendParagraph(viewer.doc, `refused ${Date.now()}`);
      const allowed = `an editor wrote this at ${Date.now()}`;
      appendParagraph(editor.doc, allowed);
      await waitFor(
        () => textOf(viewer.doc).includes(allowed),
        'the viewer to receive the editor edit',
      );
    } finally {
      viewer.destroy();
      editor.destroy();
    }
  });
});

describe('the handshake', () => {
  it('refuses a token signed with the wrong secret', async () => {
    const stranger = { ...IRIS };
    const connected = await connect({
      base: REPLICA_ONE,
      documentId,
      user: stranger,
      clientId: 61,
      expectFailure: true,
      // A valid user, a valid document, and a signature this server cannot verify.
      secret: 'a-secret-this-server-does-not-have-at-all',
    });
    try {
      expect(connected.refused()).toBe(true);
    } finally {
      connected.destroy();
    }
  });

  it('refuses a caller with no membership and no link', async () => {
    const stranger: SessionUser = {
      id: 'cstranger00000000000000000',
      email: 'stranger@collab.test',
      name: 'A Stranger',
    };
    const connected = await connect({
      base: REPLICA_ONE,
      documentId,
      user: stranger,
      clientId: 62,
      expectFailure: true,
    });
    try {
      expect(connected.refused()).toBe(true);
    } finally {
      connected.destroy();
    }
  });

  it('refuses a soft-deleted document even to its owner', async () => {
    // A deleted document must not be readable by anyone who kept the URL, and a
    // reconnecting client must not be able to resurrect it by syncing an offline
    // copy back.
    const connected = await connect({
      base: REPLICA_ONE,
      documentId: deletedDocumentId,
      user: IRIS,
      clientId: 63,
      expectFailure: true,
    });
    try {
      expect(connected.refused()).toBe(true);
    } finally {
      connected.destroy();
    }
  });
});

describe('share links', () => {
  const outsider: SessionUser = {
    id: 'coutsider00000000000000000',
    email: 'outsider@collab.test',
    name: 'An Outsider',
  };

  beforeAll(async () => {
    // A real account with no membership on the document: the link is the only
    // thing granting access, which is the whole point of the test.
    await db.user.upsert({
      where: { email: outsider.email },
      update: {},
      create: {
        id: outsider.id,
        email: outsider.email,
        name: outsider.name,
        passwordHash: 'scrypt:00:00',
      },
    });
  });

  it('lets a live view-only link in, read-only', async () => {
    const guest = await connect({
      base: REPLICA_ONE,
      documentId,
      user: outsider,
      clientId: 71,
      shareToken: LIVE_LINK,
    });
    const editor = await connect({ base: REPLICA_TWO, documentId, user: IRIS, clientId: 72 });
    try {
      expect(textOf(guest.doc)).toContain('A CRDT lives in memory');

      const before = textOf(editor.doc);
      appendParagraph(guest.doc, `a guest wrote this at ${Date.now()}`);
      await sleep(2000);
      expect(textOf(editor.doc), 'a view-only link must not be able to write').toBe(before);
    } finally {
      guest.destroy();
      editor.destroy();
    }
  });

  it('refuses a revoked link', async () => {
    const guest = await connect({
      base: REPLICA_ONE,
      documentId,
      user: outsider,
      clientId: 73,
      shareToken: REVOKED_LINK,
      expectFailure: true,
    });
    try {
      expect(guest.refused()).toBe(true);
    } finally {
      guest.destroy();
    }
  });

  it('refuses a token that matches no link', async () => {
    const guest = await connect({
      base: REPLICA_ONE,
      documentId,
      user: outsider,
      clientId: 74,
      shareToken: 'a-token-that-was-never-issued-by-anyone',
      expectFailure: true,
    });
    try {
      expect(guest.refused()).toBe(true);
    } finally {
      guest.destroy();
    }
  });

  it('refuses a live link presented for a different document', async () => {
    // Without the document check the token is a credential for the whole table:
    // edit the id in the URL, keep the token.
    const other = await db.document.findFirstOrThrow({
      where: { title: 'Weekly retro', deletedAt: null },
      select: { id: true },
    });
    const guest = await connect({
      base: REPLICA_ONE,
      documentId: other.id,
      user: outsider,
      clientId: 75,
      shareToken: LIVE_LINK,
      expectFailure: true,
    });
    try {
      expect(guest.refused()).toBe(true);
    } finally {
      guest.destroy();
    }
  });
});
