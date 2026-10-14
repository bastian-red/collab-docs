/**
 * Version history, read side.
 *
 * There is no `POST` here and no restore endpoint, and both absences are the
 * design. Cutting a version needs the live document, which only `apps/sync` has;
 * restoring one is an ordinary edit the client makes over the socket
 * (docs/SPECS.md 5.2). What this API owns is the list and the bytes, and the
 * bytes have one job: they must materialise into the document that was saved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IRIS, MARA, THEO, boot, call, loadSeedUsers, type Harness } from './support.js';

let harness: Harness;
let documentId = '';

beforeAll(async () => {
  harness = await boot();
  await loadSeedUsers(harness.db);
  const document = await harness.db.document.findFirstOrThrow({
    where: { title: 'Sync protocol notes', deletedAt: null },
    select: { id: true },
  });
  documentId = document.id;
});

afterAll(async () => {
  await harness.close();
});

describe('listing', () => {
  it('answers newest first, by number and not by timestamp', async () => {
    const reply = await call<
      Array<{ n: number; kind: string; label: string | null; bytes: number }>
    >(harness, 'GET', `/documents/${documentId}/versions`, { user: IRIS });
    expect(reply.status).toBe(200);
    expect(reply.body.length).toBeGreaterThanOrEqual(3);

    // `n` is allocated under a unique constraint, so two versions can share a
    // millisecond but not a number. Ordering by `created_at` would make the
    // panel's order differ between renders.
    const numbers = reply.body.map((version) => version.n);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    for (const version of reply.body) expect(version.bytes).toBeGreaterThan(0);
  });

  it('names who cut a labelled version', async () => {
    const reply = await call<
      Array<{ kind: string; label: string | null; authorName: string | null }>
    >(harness, 'GET', `/documents/${documentId}/versions`, { user: IRIS });
    const manual = reply.body.find((version) => version.kind === 'MANUAL');
    expect(manual?.label).toBe('Before the read-only section');
    // Who CUT it. With garbage collection on there is no per-character
    // attribution, and a field called `author` beside a diff would imply there
    // is.
    expect(manual?.authorName).toBe(IRIS.name);
  });

  it('lets a commenter read the history and refuses a viewer', async () => {
    // `version.read` reaches COMMENTER and stops there. A VIEWER's row in the
    // matrix is `document.read` and nothing else.
    const seeded = await harness.db.documentMember.findMany({
      where: { documentId },
      select: { userId: true, role: true },
    });
    expect(seeded.find((member) => member.userId === MARA.id)?.role).toBe('VIEWER');

    expect(
      (await call(harness, 'GET', `/documents/${documentId}/versions`, { user: MARA })).status,
    ).toBe(403);
    expect(
      (await call(harness, 'GET', `/documents/${documentId}/versions`, { user: THEO })).status,
    ).toBe(200);
  });
});

describe("a version's bytes", () => {
  /**
   * The bytes come back unchanged, byte for byte.
   *
   * **This test does not materialise a `Y.Doc`, and cannot.** `apps/api` is
   * CommonJS and `yjs` ships ESM-only types, so importing it here is a TS1479 --
   * which is the same boundary that keeps `@docs/db/documents` unreachable from
   * this package (docs/CODESTYLE.md section 9). That is not a gap in coverage:
   * `apps/sync/integration/versions.test.ts` applies these same bytes to a real
   * document and asserts the text. What this endpoint owns is the transport, and
   * the transport's contract is "exactly what is in the column, base64".
   */
  it('round-trips the stored state, byte for byte', async () => {
    const list = await call<Array<{ n: number; bytes: number }>>(
      harness,
      'GET',
      `/documents/${documentId}/versions`,
      { user: IRIS },
    );
    const oldest = list.body[list.body.length - 1]!;

    const reply = await call<{ n: number; state: string }>(
      harness,
      'GET',
      `/documents/${documentId}/versions/${String(oldest.n)}/state`,
      { user: IRIS },
    );
    expect(reply.status).toBe(200);
    expect(reply.body.n).toBe(oldest.n);

    const stored = await harness.db.documentVersion.findUniqueOrThrow({
      where: { documentId_n: { documentId, n: oldest.n } },
      select: { state: true },
    });
    const decoded = Buffer.from(reply.body.state, 'base64');
    expect(decoded.equals(Buffer.from(stored.state))).toBe(true);
    // And the size the list reported is the size of what the state route serves,
    // so the panel's "12 KB" is not a different number from the download.
    expect(decoded.byteLength).toBe(oldest.bytes);
    expect(decoded.byteLength).toBeGreaterThan(2);
  });

  it('answers 404 for a version number that is not there', async () => {
    const reply = await call(harness, 'GET', `/documents/${documentId}/versions/9999/state`, {
      user: IRIS,
    });
    expect(reply.status).toBe(404);
  });

  it('refuses a version number that is not a positive integer', async () => {
    for (const n of ['0', '-1', 'banana', '1.5']) {
      const reply = await call(harness, 'GET', `/documents/${documentId}/versions/${n}/state`, {
        user: IRIS,
      });
      expect(reply.status, n).toBe(400);
    }
  });

  it('tells a stranger the document does not exist', async () => {
    const stranger = { id: 'cstrangernobodyatall00000', email: 's@example.com', name: 'S' };
    const reply = await call(harness, 'GET', `/documents/${documentId}/versions/1/state`, {
      user: stranger,
    });
    expect(reply.status).toBe(404);
  });
});
