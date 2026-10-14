/**
 * Folders: a tree in a self-referencing column.
 *
 * `CHECK ("id" <> "parent_id")` stops the one-node cycle in the database. It
 * cannot stop A -> B -> A, because that needs two rows and Postgres has no cheap
 * way to express "no cycles" over one table, so that is refused in
 * `services/doc-access` before the UPDATE -- and this lane is where the two halves
 * are shown to actually meet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  IRIS,
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
const folders: string[] = [];
const documents: string[] = [];

beforeAll(async () => {
  harness = await boot();
  await loadSeedUsers(harness.db);
});

afterAll(async () => {
  await removeDocuments(harness.db, documents);
  await harness.db.folder.deleteMany({ where: { id: { in: folders } } });
  await harness.close();
});

async function folder(name: string, parentId: string | null = null): Promise<string> {
  const reply = await call<{ id: string }>(harness, 'POST', '/folders', {
    user: IRIS,
    body: { name, ...(parentId === null ? {} : { parentId }) },
  });
  if (reply.status !== 201) {
    throw new Error(
      `could not create a folder: ${String(reply.status)} ${JSON.stringify(reply.body)}`,
    );
  }
  folders.push(reply.body.id);
  return reply.body.id;
}

describe('the depth cap', () => {
  it('allows one level of nesting and refuses two', async () => {
    const root = await folder(uniqueTitle('Root'));
    const child = await folder(uniqueTitle('Child'), root);

    const grandchild = await call(harness, 'POST', '/folders', {
      user: IRIS,
      body: { name: uniqueTitle('Grandchild'), parentId: child },
    });
    expect(grandchild.status).toBe(400);
    expect(grandchild.body).toMatchObject({ code: 'INVALID' });
  });

  it('refuses a move that would push a folder past the cap', async () => {
    const root = await folder(uniqueTitle('Cap root'));
    const child = await folder(uniqueTitle('Cap child'), root);
    const other = await folder(uniqueTitle('Cap other'));

    const reply = await call(harness, 'POST', `/folders/${other}/move`, {
      user: IRIS,
      body: { parentId: child },
    });
    expect(reply.status).toBe(400);
  });
});

describe('cycles', () => {
  /**
   * The self-move. `CHECK ("id" <> "parent_id")` would also refuse it, but as a
   * 500 from a constraint rather than as a sentence -- so it is refused above
   * the database, and this asserts which of the two answered.
   */
  it('refuses a folder becoming its own parent, with a message and not a constraint error', async () => {
    const id = await folder(uniqueTitle('Self'));
    const reply = await call(harness, 'POST', `/folders/${id}/move`, {
      user: IRIS,
      body: { parentId: id },
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ code: 'INVALID' });
  });

  /**
   * A -> B -> A. Two rows, so no CHECK constraint can see it; the ancestry walk
   * is the only thing in the way. A cycle here is not a bad render -- it is a
   * breadcrumb walk that never terminates.
   */
  it('refuses a two-node cycle', async () => {
    const a = await folder(uniqueTitle('A'));
    const b = await folder(uniqueTitle('B'), a);

    const reply = await call(harness, 'POST', `/folders/${a}/move`, {
      user: IRIS,
      body: { parentId: b },
    });
    expect(reply.status).toBe(400);

    // And nothing moved.
    const row = await harness.db.folder.findUniqueOrThrow({
      where: { id: a },
      select: { parentId: true },
    });
    expect(row.parentId).toBeNull();
  });
});

describe('ownership', () => {
  it('shows a person only their own folders', async () => {
    const mine = await folder(uniqueTitle('Mine'));
    const theirs = await call<{ id: string }>(harness, 'POST', '/folders', {
      user: THEO,
      body: { name: uniqueTitle('Theirs') },
    });
    folders.push(theirs.body.id);

    const list = await call<Array<{ id: string }>>(harness, 'GET', '/folders', { user: IRIS });
    const ids = list.body.map((row) => row.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs.body.id);
  });

  it("answers 404 for somebody else's folder, not 403", async () => {
    const theirs = await call<{ id: string }>(harness, 'POST', '/folders', {
      user: THEO,
      body: { name: uniqueTitle('Not yours') },
    });
    folders.push(theirs.body.id);

    const reply = await call(harness, 'PATCH', `/folders/${theirs.body.id}`, {
      user: IRIS,
      body: { name: 'Renamed' },
    });
    expect(reply.status).toBe(404);
  });
});

describe('deleting a folder', () => {
  /**
   * `folder_id` is `ON DELETE SET NULL`, so the documents move to the root.
   * Cascading would mean one click destroying every document somebody had filed,
   * including ones other people are editing right now.
   */
  it('moves its documents to the root rather than deleting them', async () => {
    const id = await folder(uniqueTitle('Doomed folder'));
    const documentId = await createDocument(harness, IRIS, uniqueTitle('Filed'));
    documents.push(documentId);
    await call(harness, 'POST', `/documents/${documentId}/move`, {
      user: IRIS,
      body: { folderId: id },
    });

    const removed = await call(harness, 'DELETE', `/folders/${id}`, { user: IRIS });
    expect(removed.status).toBe(200);

    const detail = await call<{ folderId: string | null; folderName: string | null }>(
      harness,
      'GET',
      `/documents/${documentId}`,
      { user: IRIS },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.folderId).toBeNull();
    expect(detail.body.folderName).toBeNull();
  });

  it('counts only the documents that are still there', async () => {
    const id = await folder(uniqueTitle('Counting'));
    const kept = await createDocument(harness, IRIS, uniqueTitle('Kept'));
    const binned = await createDocument(harness, IRIS, uniqueTitle('Binned'));
    documents.push(kept, binned);

    for (const documentId of [kept, binned]) {
      await call(harness, 'POST', `/documents/${documentId}/move`, {
        user: IRIS,
        body: { folderId: id },
      });
    }
    await call(harness, 'DELETE', `/documents/${binned}`, { user: IRIS });

    const list = await call<Array<{ id: string; documentCount: number }>>(
      harness,
      'GET',
      '/folders',
      {
        user: IRIS,
      },
    );
    const row = list.body.find((entry) => entry.id === id);
    // A folder reporting two documents that opens onto one is a bug report every
    // time, and `deleted_at` is the whole difference.
    expect(row?.documentCount).toBe(1);
  });
});
