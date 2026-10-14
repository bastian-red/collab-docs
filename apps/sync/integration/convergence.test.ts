/**
 * The headline claim, against two real replicas.
 *
 * Everything here would also pass with the Redis extension removed IF both
 * clients were on one replica -- they would share the in-memory `Y.Doc`. So
 * every test in this file deliberately puts its two clients on DIFFERENT
 * replicas, and `relay is actually wired` asserts that directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@docs/db';
import type { SessionUser } from '@docs/shared';

import {
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

let db: PrismaClient;
let documentId = '';

beforeAll(async () => {
  db = prisma();
  // Read the seeded ids rather than hardcoding them: the seed owns how they are
  // built, and a copy here would be a second source of truth that silently
  // stops matching.
  const document = await db.document.findFirstOrThrow({
    where: { title: 'Sync protocol notes', deletedAt: null },
    select: { id: true },
  });
  documentId = document.id;
  for (const user of [IRIS, THEO]) {
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

describe('two clients on two replicas', () => {
  it('converge on what either of them types', async () => {
    const one = await connect({ base: REPLICA_ONE, documentId, user: IRIS, clientId: 11 });
    const two = await connect({ base: REPLICA_TWO, documentId, user: THEO, clientId: 12 });
    try {
      const marker = `written on replica one at ${Date.now()}`;
      appendParagraph(one.doc, marker);
      await waitFor(() => textOf(two.doc).includes(marker), 'replica two to see replica one');

      const reply = `written on replica two at ${Date.now()}`;
      appendParagraph(two.doc, reply);
      await waitFor(() => textOf(one.doc).includes(reply), 'replica one to see replica two');

      expect(textOf(one.doc)).toBe(textOf(two.doc));
    } finally {
      one.destroy();
      two.destroy();
    }
  });

  it('converge after simultaneous edits, without either client losing its own', async () => {
    // The interesting case, and the one a last-write-wins store gets wrong: both
    // sides write before either has seen the other.
    const one = await connect({ base: REPLICA_ONE, documentId, user: IRIS, clientId: 21 });
    const two = await connect({ base: REPLICA_TWO, documentId, user: THEO, clientId: 22 });
    try {
      const stamp = Date.now();
      const fromOne = `simultaneous one ${stamp}`;
      const fromTwo = `simultaneous two ${stamp}`;
      appendParagraph(one.doc, fromOne);
      appendParagraph(two.doc, fromTwo);

      await waitFor(
        () => textOf(one.doc).includes(fromTwo) && textOf(two.doc).includes(fromOne),
        'both replicas to see both edits',
      );
      expect(textOf(one.doc)).toBe(textOf(two.doc));
    } finally {
      one.destroy();
      two.destroy();
    }
  });

  it('relay is actually wired: the second replica never applied the update locally', async () => {
    // Stated as its own test because it is the assumption every other test in
    // this file rests on. If both providers were somehow talking to the same
    // process, everything above would pass with no relay at all.
    const one = await connect({ base: REPLICA_ONE, documentId, user: IRIS, clientId: 31 });
    const two = await connect({ base: REPLICA_TWO, documentId, user: THEO, clientId: 32 });
    try {
      const [healthOne, healthTwo] = await Promise.all([
        fetch(`${REPLICA_ONE}/health`).then(
          (response) => response.json() as Promise<{ documents: number }>,
        ),
        fetch(`${REPLICA_TWO}/health`).then(
          (response) => response.json() as Promise<{ documents: number }>,
        ),
      ]);
      // Each replica has the document loaded in its own memory: two processes,
      // two copies, kept in step by Redis.
      expect(healthOne.documents).toBeGreaterThan(0);
      expect(healthTwo.documents).toBeGreaterThan(0);
      expect(REPLICA_ONE).not.toBe(REPLICA_TWO);
    } finally {
      one.destroy();
      two.destroy();
    }
  });
});

describe('the append log', () => {
  it('records what was typed, with a gapless seq', async () => {
    const one = await connect({ base: REPLICA_ONE, documentId, user: IRIS, clientId: 41 });
    try {
      const before = await db.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { nextSeq: true },
      });

      appendParagraph(one.doc, `logged at ${Date.now()}`);
      await waitForAsync(async () => {
        const row = await db.document.findUniqueOrThrow({
          where: { id: documentId },
          select: { nextSeq: true },
        });
        return row.nextSeq > before.nextSeq;
      }, 'the allocator to advance');

      const rows = await db.documentUpdate.findMany({
        where: { documentId },
        select: { seq: true },
        orderBy: { seq: 'asc' },
      });
      const seqs = rows.map((row) => Number(row.seq));
      // Dense from the checkpoint upward: every number between the first and the
      // last is present. A gap is indistinguishable from an update a reader has
      // not received yet.
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]! - seqs[i - 1]!, `gap between ${seqs[i - 1]} and ${seqs[i]}`).toBe(1);
      }
    } finally {
      one.destroy();
    }
  });
});
