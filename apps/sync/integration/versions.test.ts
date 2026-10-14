/**
 * The two proofs docs/SPECS.md 9.2 lists that nothing else covers:
 *
 *   9.2.6  `seq` under N concurrent appenders: no gaps, no duplicates.
 *   9.2.7  Restore a version on one replica; a client on the other sees it.
 *
 * Both need more than one writer against the real allocator, so neither can live
 * in the gate lane: the property under test is a row lock in Postgres, and an
 * in-memory repository would prove only that the fake is sequential.
 */
import type { PrismaClient } from '@docs/db';
import type { SessionUser, VersionSummary } from '@docs/shared';
import { mintServiceToken } from '@docs/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  AUTH_SECRET,
  REPLICA_ONE,
  REPLICA_TWO,
  appendParagraph,
  connect,
  prisma,
  textOf,
  waitFor,
  waitForAsync,
} from './support.js';

const IRIS: SessionUser = { id: '', email: 'iris@collab.test', name: 'Iris Almeida' };
const THEO: SessionUser = { id: '', email: 'theo@collab.test', name: 'Theo Nakamura' };
const MARA: SessionUser = { id: '', email: 'mara@collab.test', name: 'Mara Villalobos' };

let db: PrismaClient;
let documentId = '';

beforeAll(async () => {
  db = prisma();
  const document = await db.document.findFirstOrThrow({
    where: { title: 'Sync protocol notes', deletedAt: null },
    select: { id: true },
  });
  documentId = document.id;
  for (const user of [IRIS, THEO, MARA]) {
    const row = await db.user.findUniqueOrThrow({
      where: { email: user.email },
      select: { id: true },
    });
    user.id = row.id;
  }
});

afterAll(async () => {
  await db.$disconnect();
});

/**
 * Two version numbers that exist right now.
 *
 * NOT 1 and 2. This lane runs with `VERSION_INTERVAL_SECONDS=1`, so an edited
 * document cuts automatic versions continuously and the prune eventually drops
 * the oldest of them -- including the seed's. Hardcoding the numbers makes the
 * diff tests fail with a 404 on a run that happened to be long enough, which is
 * a flake that looks like a bug in the diff.
 */
async function twoVersionNumbers(): Promise<[number, number]> {
  const rows = await db.documentVersion.findMany({
    where: { documentId },
    select: { n: true },
    orderBy: { n: 'asc' },
    take: 2,
  });
  if (rows.length < 2) throw new Error('The seed should leave this document with three versions.');
  return [rows[0]!.n, rows[1]!.n];
}

/** `POST /documents/:id/versions` against a replica, as a signed-in caller would. */
async function cutVersion(
  base: string,
  user: SessionUser,
  label: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/documents/${documentId}/versions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mintServiceToken(user, AUTH_SECRET)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ label }),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * 9.2.6. The allocator under concurrent writers.
 *
 * `seq` comes from `UPDATE documents SET next_seq = next_seq + 1 RETURNING`,
 * inside the same transaction as the INSERT. The row lock is what serialises the
 * writers; the transaction is what stops a crash between the two from burning a
 * number and leaving a gap. Neither is visible from one client, which is why this
 * test writes from two replicas at once.
 */
describe('seq under concurrent appenders', () => {
  it('hands out a dense, unique sequence with no gaps', async () => {
    const one = await connect({ base: REPLICA_ONE, documentId, user: IRIS, clientId: 61 });
    const two = await connect({ base: REPLICA_TWO, documentId, user: THEO, clientId: 62 });

    try {
      const before = await db.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { nextSeq: true },
      });

      // Interleaved rather than "all of one then all of the other": alternating
      // is what puts two INSERTs in flight against the same row at the same
      // instant, which is the case the lock exists for.
      const marker = `seq-race-${Date.now()}`;
      const WRITES = 12;
      for (let i = 0; i < WRITES; i += 1) {
        appendParagraph(i % 2 === 0 ? one.doc : two.doc, `${marker}-${String(i)}`);
      }

      // Every write must have reached the log before the sequence is read, or a
      // "no gaps" assertion over a partial log is vacuous.
      await waitForAsync(
        async () => {
          const row = await db.document.findUniqueOrThrow({
            where: { id: documentId },
            select: { nextSeq: true },
          });
          return row.nextSeq >= before.nextSeq + BigInt(WRITES);
        },
        `${String(WRITES)} appends to reach the allocator`,
      );

      // Read the log itself, above the checkpoint. Compaction deletes rows at or
      // below `state_seq`, so anything at or below it is legitimately absent and
      // asking about it would make this test fail for the wrong reason.
      //
      // Both reads in ONE repeatable-read transaction. `COMPACT_AFTER_UPDATES`
      // is 3 in this lane, so a compaction between the two queries would move
      // `state_seq` under the row list and the density assertion below would
      // fail against a perfectly correct log.
      const { document, seqs } = await db.$transaction(
        async (tx) => {
          const row = await tx.document.findUniqueOrThrow({
            where: { id: documentId },
            select: { stateSeq: true, nextSeq: true },
          });
          const updates = await tx.documentUpdate.findMany({
            where: { documentId, seq: { gt: row.stateSeq } },
            select: { seq: true },
            orderBy: { seq: 'asc' },
          });
          return { document: row, seqs: updates.map((update) => update.seq) };
        },
        { isolationLevel: 'RepeatableRead' },
      );

      expect(seqs.length).toBeGreaterThan(0);

      /**
       * Density, stated in a way compaction cannot weaken.
       *
       * The rows above the checkpoint must be exactly
       * `state_seq + 1 .. next_seq - 1`, with nothing missing. Checking only
       * "consecutive" would pass on a log that had been truncated to two rows,
       * which is a real possibility here -- the lane compacts every three
       * updates -- and a two-row window is not evidence of anything.
       */
      expect(seqs.length).toBe(Number(document.nextSeq - document.stateSeq) - 1);

      // No duplicates. `PRIMARY KEY (document_id, seq)` makes this impossible at
      // the database level, so a failure here means the primary key is gone.
      expect(new Set(seqs.map(String)).size).toBe(seqs.length);

      // No gaps. This is the one the lock actually buys: two writers reading
      // `next_seq` outside a transaction would both see N, both write N+1, and
      // one INSERT would lose -- leaving a hole that a later replay reads as a
      // truncated document.
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i], `gap between ${String(seqs[i - 1])} and ${String(seqs[i])}`).toBe(
          seqs[i - 1]! + 1n,
        );
      }

      // And the allocator's own counter agrees with the highest row it handed
      // out, which is what "dense" means from the other side.
      expect(document.nextSeq).toBe(seqs[seqs.length - 1]! + 1n);
    } finally {
      one.destroy();
      two.destroy();
    }
  });
});

/**
 * 9.2.7. Restore, across replicas.
 *
 * A restore is not a rollback primitive. There is none in a garbage-collected
 * Yjs document, and inventing one would mean a second write path. So the client
 * materialises the version in a detached `Y.Doc`, reads its content, and applies
 * it to the live document as an ordinary edit (docs/SPECS.md 5.2) -- which is why
 * the other replica sees it the same way it sees typing, and why a viewer cannot
 * do it without a single line of code saying so.
 */
describe('restore a version', () => {
  it('cuts a version on one replica and restores it from the other', async () => {
    const one = await connect({ base: REPLICA_ONE, documentId, user: IRIS, clientId: 71 });
    const two = await connect({ base: REPLICA_TWO, documentId, user: THEO, clientId: 72 });

    try {
      const kept = `kept-${Date.now()}`;
      appendParagraph(one.doc, kept);
      await waitFor(() => textOf(two.doc).includes(kept), 'replica two to see the paragraph');

      // Cut the version through the endpoint, on replica one.
      const cut = await cutVersion(REPLICA_ONE, IRIS, `restore point ${kept}`);
      expect(cut.status).toBe(201);
      const version = cut.body as VersionSummary;
      expect(version.kind).toBe('MANUAL');
      expect(version.authorName).toBe('Iris Almeida');

      // The version has to contain the paragraph, or the restore below would
      // prove nothing. It is read back through the API's own path: the stored
      // bytes, materialised.
      const stored = await db.documentVersion.findUniqueOrThrow({
        where: { documentId_n: { documentId, n: version.n } },
        select: { state: true },
      });
      const materialised = new Y.Doc();
      Y.applyUpdate(materialised, Uint8Array.from(stored.state));
      expect(textOf(materialised)).toContain(kept);
      materialised.destroy();

      // Now diverge from it, on replica two.
      const regretted = `regretted-${Date.now()}`;
      appendParagraph(two.doc, regretted);
      await waitFor(() => textOf(one.doc).includes(regretted), 'replica one to see the mistake');

      // Restore, on replica ONE, exactly the way the editor does it: replace the
      // live fragment's contents with the version's, inside one transaction.
      const source = new Y.Doc();
      Y.applyUpdate(source, Uint8Array.from(stored.state));
      const restored = source
        .getXmlFragment('default')
        .toArray()
        .map((node) => node.toString());
      source.destroy();

      Y.transact(one.doc, () => {
        const fragment = one.doc.getXmlFragment('default');
        fragment.delete(0, fragment.length);
        for (const html of restored) {
          const text = html.replace(/<[^>]*>/gu, '');
          const element = new Y.XmlElement('paragraph');
          fragment.insert(fragment.length, [element]);
          element.insert(0, [new Y.XmlText(text)]);
        }
      });

      // The other replica converges on the restore, and the paragraph written
      // after the version is gone from it. That second half is the honest
      // caveat docs/SPECS.md 5.2 states in the UI as well: a restore replaces
      // the whole document, so an edit made during the round trip is inside the
      // replaced range.
      await waitFor(
        () => textOf(two.doc).includes(kept) && !textOf(two.doc).includes(regretted),
        'replica two to converge on the restore',
      );

      // And it travelled as an ordinary edit: it is in the log, like typing.
      await waitForAsync(async () => {
        const doc = await db.document.findUniqueOrThrow({
          where: { id: documentId },
          select: { stateSeq: true },
        });
        const rows = await db.documentUpdate.findMany({
          where: { documentId, seq: { gt: doc.stateSeq } },
          select: { update: true },
        });
        const replay = new Y.Doc();
        const snapshot = await db.document.findUniqueOrThrow({
          where: { id: documentId },
          select: { state: true },
        });
        Y.applyUpdate(replay, Uint8Array.from(snapshot.state));
        for (const row of rows) Y.applyUpdate(replay, Uint8Array.from(row.update));
        const text = textOf(replay);
        replay.destroy();
        return text.includes(kept) && !text.includes(regretted);
      }, 'the restore to be durable in the checkpoint plus log');
    } finally {
      one.destroy();
      two.destroy();
    }
  });

  /**
   * The guarantee that composes rather than being restated.
   *
   * `version.create` is not in a `VIEWER`'s row of the matrix, so the endpoint
   * refuses. Nothing in the route says "viewers may not save versions"; it asks
   * the same matrix the socket asks.
   */
  it('refuses a viewer cutting a version', async () => {
    const response = await cutVersion(REPLICA_ONE, MARA, 'not mine to make');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  /**
   * The endpoint that used to serve a document's full text to anybody who could
   * guess an id. It is the same document these tests have been reading all along,
   * so a regression here is a regression in the only thing standing between a
   * document and the open internet.
   */
  it('refuses an unauthenticated diff', async () => {
    const [from] = await twoVersionNumbers();
    const response = await fetch(
      `${REPLICA_ONE}/documents/${documentId}/diff?from=${String(from)}`,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  /**
   * A stranger with a perfectly good token.
   *
   * 404 and not 403: being told "forbidden" about a document id confirms the id
   * exists, and ids are guessable enough to iterate. The same answer a
   * non-existent document gives, which is the point.
   *
   * It is also the test that catches the `HandshakeRefused` leak: without the
   * mapping in `authoriseDocumentRequest` this answers 500, which a client reads
   * as a server fault and retries.
   */
  it('answers a signed-in stranger the same way it answers a missing document', async () => {
    const stranger: SessionUser = {
      id: 'cstrangernobodyatall00000',
      email: 'stranger@example.com',
      name: 'A Stranger',
    };
    const [from] = await twoVersionNumbers();
    const headers = { authorization: `Bearer ${mintServiceToken(stranger, AUTH_SECRET)}` };

    const onReal = await fetch(`${REPLICA_ONE}/documents/${documentId}/diff?from=${String(from)}`, {
      headers,
    });
    const onMissing = await fetch(
      `${REPLICA_ONE}/documents/cnosuchdocument0000000000/diff?from=${String(from)}`,
      { headers },
    );

    expect(onReal.status).toBe(404);
    expect(onMissing.status).toBe(404);
    expect(await onReal.json()).toEqual(await onMissing.json());
  });

  it('serves a diff to a member who presents a token', async () => {
    const [from, to] = await twoVersionNumbers();
    const response = await fetch(
      `${REPLICA_ONE}/documents/${documentId}/diff?from=${String(from)}&to=${String(to)}`,
      { headers: { authorization: `Bearer ${mintServiceToken(IRIS, AUTH_SECRET)}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { from: number; to: number; lines: unknown[] };
    expect(body.from).toBe(from);
    expect(body.to).toBe(to);
    expect(body.lines.length).toBeGreaterThan(0);
  });

  /**
   * A `VIEWER`'s row in the matrix is `document.read` and nothing else, so
   * `version.read` is refused -- the diff included. A `COMMENTER` has
   * `version.read` and would be served.
   *
   * That asymmetry is exactly why the matrix is written out in full rather than
   * derived from a rank: it is the kind of rule a derived one cannot express.
   */
  it('refuses a viewer reading a diff', async () => {
    const [from, to] = await twoVersionNumbers();
    const response = await fetch(
      `${REPLICA_ONE}/documents/${documentId}/diff?from=${String(from)}&to=${String(to)}`,
      { headers: { authorization: `Bearer ${mintServiceToken(MARA, AUTH_SECRET)}` } },
    );
    expect(response.status).toBe(403);
  });
});
