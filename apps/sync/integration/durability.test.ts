/**
 * The claim the whole persistence design exists for: a `kill -9` loses nothing.
 *
 * This file starts its OWN replica, on its own port, so it can kill it without
 * taking the two that `scripts/integration.sh` started down with it. `SIGKILL`,
 * not `SIGTERM`: a graceful shutdown flushes pending stores, which is precisely
 * the code path that must NOT be what saves the data. The point is that nothing
 * was pending in the first place.
 *
 * The naive Yjs design -- hold the doc in memory, write it on a debounce -- fails
 * this test by construction, and `STORE_DEBOUNCE_MS` is set low by
 * `integration.sh` so a debounced write would look tempting: even at 200ms the
 * gap below is smaller.
 */
import type { PrismaClient } from '@docs/db';
import type { SessionUser } from '@docs/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appendParagraph, connect, prisma, sleep, textOf, waitForAsync } from './support.js';

/**
 * The allocator's next number, which is the only monotonic witness that an
 * append happened.
 *
 * NOT the row count. `COMPACT_AFTER_UPDATES` is 3 in this lane, so a compaction
 * can DELETE log rows while a test is waiting, and "the count went up" then
 * never becomes true -- a test that hangs for ten seconds and reports a
 * durability failure that is really a compaction doing its job. `next_seq` only
 * ever goes up.
 */
async function nextSeq(db: PrismaClient, documentId: string): Promise<bigint> {
  const row = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { nextSeq: true },
  });
  return row.nextSeq;
}

const PORT = 4102;
const BASE = `http://localhost:${PORT}`;

const IRIS: SessionUser = { id: '', email: 'iris@collab.test', name: 'Iris Almeida' };

let db: PrismaClient;
let documentId = '';
let replica: ChildProcess | null = null;

/**
 * Is anything accepting TCP on the port?
 *
 * `net`, not `fetch`. Node's global fetch pools keep-alive connections, so a
 * request to a server that is going away can fail for reasons that have nothing
 * to do with the listener -- and "the request failed" then gets read as "the
 * port is closed" while the process is still very much alive. A bare TCP connect
 * answers the question that is actually being asked.
 */
async function portIsOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port: PORT, host: '127.0.0.1' });
    const settle = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

/**
 * Start a replica and wait for it to be healthy.
 *
 * `tsx src/main.ts` -- the same entry point `pnpm dev` and `integration.sh` use.
 * A lane that starts the app its own way tests a program nobody else runs.
 */
async function startReplica(): Promise<ChildProcess> {
  // Refuse to start on an occupied port. Without this, a replica left behind by
  // an earlier crashed run answers /health, `startReplica` returns a child that
  // died of EADDRINUSE, and every kill in this file then waits ten seconds for a
  // port that belongs to a process it never started. The first version of this
  // file spent three runs looking like a durability bug for exactly that reason.
  if (await portIsOpen()) {
    throw new Error(
      `Something is already listening on ${PORT}. A replica from an earlier run is still ` +
        `alive: find it with \`ss -ltnp | grep ${PORT}\` and kill it.`,
    );
  }

  // `detached: true` puts the replica in its own process group, which is what
  // makes the kill below reach the whole tree. `pnpm exec tsx` is three
  // processes -- pnpm, tsx, node -- and killing only the first leaves node
  // holding the port, so the restart fails with EADDRINUSE and the test reads
  // as a durability failure. That is not hypothetical; it is what the first
  // version of this file did.
  const child = spawn('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
    detached: true,
  });

  await waitForAsync(
    async () => {
      try {
        const response = await fetch(`${BASE}/health`);
        return response.status === 200;
      } catch {
        return false;
      }
    },
    `replica on ${PORT} to become healthy`,
    30_000,
  );
  return child;
}

async function kill9(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  // The NEGATIVE pid is the process group. `child.kill()` would signal only the
  // pnpm wrapper and leave the node process that actually holds the socket
  // running -- which is not the crash this test is trying to simulate.
  if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  await exited;
  // The port has to be free before the replacement binds it, or the restart
  // fails with EADDRINUSE and the test reads as a durability failure.
  await waitForAsync(async () => !(await portIsOpen()), `port ${PORT} to close`);
}

beforeAll(async () => {
  db = prisma();
  documentId = (
    await db.document.findFirstOrThrow({
      where: { title: 'Onboarding checklist', deletedAt: null },
      select: { id: true },
    })
  ).id;
  IRIS.id = (
    await db.user.findUniqueOrThrow({ where: { email: IRIS.email }, select: { id: true } })
  ).id;
});

/**
 * One replica per test, started and stopped around it.
 *
 * Not one for the file: two of the tests below kill and restart it, so a
 * file-wide instance would leave the next test to find its port occupied by the
 * previous test's replacement -- which the guard in `startReplica` reports as
 * "something is already listening", correctly and unhelpfully.
 */
beforeEach(async () => {
  replica = await startReplica();
});

afterEach(async () => {
  if (replica !== null && replica.exitCode === null) await kill9(replica);
  replica = null;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('kill -9', () => {
  it('loses nothing that was typed before it', async () => {
    const marker = `typed just before the crash at ${Date.now()}`;
    const client = await connect({ base: BASE, documentId, user: IRIS, clientId: 81 });
    // The count BEFORE, not zero. This document arrives from the seed with rows
    // already in its log, so `count > 0` is true the instant the test starts and
    // waits for nothing -- which makes the whole test pass without the update
    // ever having been written.
    const before = await nextSeq(db, documentId);
    try {
      appendParagraph(client.doc, marker);
      // Wait for the APPEND, not for a checkpoint: the log row is what
      // durability means here, and `documents.state` is allowed to be stale.
      await waitForAsync(
        async () => (await nextSeq(db, documentId)) > before,
        'the update to reach the log',
      );
    } finally {
      client.destroy();
    }

    await kill9(replica!);
    replica = await startReplica();

    const reconnected = await connect({ base: BASE, documentId, user: IRIS, clientId: 82 });
    try {
      expect(textOf(reconnected.doc)).toContain(marker);
    } finally {
      reconnected.destroy();
    }
  });

  it('writes the update with no timer in front of it, and survives a crash straight after', async () => {
    // **The test that discriminates this design from the naive one.**
    //
    // The other test above proves "what reached the log survives", which is true
    // of a debounced writer too -- it just reaches the log later. This one bounds
    // HOW LATE: the append has to land within `MAX_APPEND_LATENCY_MS` of the
    // keystroke. The real path issues the INSERT from the Yjs update listener and
    // lands in single-digit milliseconds; anything on a timer does not.
    //
    // 500ms is chosen against the two numbers it sits between: an INSERT on a
    // loaded CI box is comfortably under it, and `STORE_DEBOUNCE_MS` -- the
    // interval `@hocuspocus/extension-database` would write on, and the smallest
    // debounce anything here uses -- is 200ms in this lane and 2000ms by default.
    // Verified by making the append `setTimeout(..., 2000)`: this test goes red
    // and the one above stays green.
    const MAX_APPEND_LATENCY_MS = 500;

    const marker = `typed with no timer at ${Date.now()}`;
    const client = await connect({ base: BASE, documentId, user: IRIS, clientId: 83 });
    const before = await nextSeq(db, documentId);
    try {
      const typedAt = Date.now();
      appendParagraph(client.doc, marker);
      await waitForAsync(
        async () => (await nextSeq(db, documentId)) > before,
        `the update to reach the log within ${MAX_APPEND_LATENCY_MS}ms`,
        MAX_APPEND_LATENCY_MS,
      );
      const latency = Date.now() - typedAt;
      expect(latency, 'the append must not be on a timer').toBeLessThan(MAX_APPEND_LATENCY_MS);
    } finally {
      client.destroy();
    }

    await kill9(replica!);
    replica = await startReplica();

    const reconnected = await connect({ base: BASE, documentId, user: IRIS, clientId: 84 });
    try {
      expect(textOf(reconnected.doc)).toContain(marker);
    } finally {
      reconnected.destroy();
    }
  });
});

describe('compaction', () => {
  it('truncates the log and leaves the document identical', async () => {
    // COMPACT_AFTER_UPDATES is 3 in this lane, so a handful of paragraphs is
    // enough. At the production default of 200 this test could only be written
    // by typing two hundred of them.
    const client = await connect({ base: BASE, documentId, user: IRIS, clientId: 85 });
    try {
      const stamp = Date.now();
      for (let i = 0; i < 5; i += 1)
        appendParagraph(client.doc, `compaction line ${i} at ${stamp}`);
      const expected = textOf(client.doc);

      await waitForAsync(async () => {
        const row = await db.document.findUniqueOrThrow({
          where: { id: documentId },
          select: { stateSeq: true, contentText: true },
        });
        return row.stateSeq > 0n && row.contentText.includes(`compaction line 4 at ${stamp}`);
      }, 'the checkpoint to catch up');

      const document = await db.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { stateSeq: true, nextSeq: true },
      });
      const orphaned = await db.documentUpdate.count({
        where: { documentId, seq: { lte: document.stateSeq } },
      });
      expect(orphaned, 'nothing at or below state_seq should still be in the log').toBe(0);
      expect(
        document.nextSeq > document.stateSeq,
        'the checkpoint must stay behind the allocator',
      ).toBe(true);

      client.destroy();
      await sleep(200);

      const reopened = await connect({ base: BASE, documentId, user: IRIS, clientId: 86 });
      try {
        expect(textOf(reopened.doc)).toBe(expected);
      } finally {
        reopened.destroy();
      }
    } catch (error) {
      client.destroy();
      throw error;
    }
  });
});
