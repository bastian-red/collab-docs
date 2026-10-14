/**
 * Documents: the permission matrix as HTTP, the soft-delete hole, pagination and
 * search.
 *
 * Two of these are the reason this lane exists rather than more unit tests:
 *
 *   - **A deleted document is gone for its owner too.** `document_members` rows
 *     outlive a soft delete, so an owner still holds a role on a document that
 *     is not there. Deciding on the role alone let the owner of a deleted
 *     document keep reading, renaming and sharing it. The same hole existed on
 *     the socket side and is closed the same way; only a real query proves it.
 *   - **A stranger is told 404, never 403.** Ids are guessable enough to
 *     iterate, and "403 here, 404 there" is a directory listing.
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

/** A signed-in caller who is on nothing. Their token is valid; their access is not. */
const STRANGER = {
  id: 'cstrangernobodyatall00000',
  email: 'stranger@example.com',
  name: 'A Stranger',
};

beforeAll(async () => {
  harness = await boot();
  await loadSeedUsers(harness.db);
});

afterAll(async () => {
  await removeDocuments(harness.db, created);
  await harness.close();
});

async function own(title: string): Promise<string> {
  const id = await createDocument(harness, IRIS, title);
  created.push(id);
  return id;
}

describe('create', () => {
  it('makes the caller the owner, in the same statement', async () => {
    const title = uniqueTitle('Created');
    const id = await own(title);

    const row = await harness.db.document.findUniqueOrThrow({
      where: { id },
      select: { title: true, state: true, stateSeq: true, nextSeq: true, members: true },
    });

    // A document with no members cannot be listed, opened, deleted or shared by
    // anybody, including whoever just made it. Nesting the member row in the
    // create is what removes the window in which that is true.
    expect(row.members).toHaveLength(1);
    expect(row.members[0]?.role).toBe('OWNER');
    expect(row.members[0]?.userId).toBe(IRIS.id);

    // The encoded state of an empty Y.Doc, not an empty buffer:
    // `CHECK (octet_length(state) > 0)` refuses the latter.
    expect(Array.from(row.state)).toEqual([0, 0]);
    expect(row.stateSeq).toBe(0n);
    expect(row.nextSeq).toBe(1n);
  });

  it('answers the detail shape, with seq values as strings', async () => {
    const reply = await call<{
      stateSeq: unknown;
      nextSeq: unknown;
      stateBytes: number;
      role: string;
    }>(harness, 'POST', '/documents', { user: IRIS, body: { title: uniqueTitle('Shape') } });
    created.push((reply.body as unknown as { id: string }).id);

    expect(reply.status).toBe(201);
    // Strings. A `bigint` cannot be serialised at all -- `JSON.stringify` throws
    // -- so this is the difference between a working endpoint and a 500.
    expect(reply.body.stateSeq).toBe('0');
    expect(reply.body.nextSeq).toBe('1');
    expect(reply.body.stateBytes).toBe(2);
    expect(reply.body.role).toBe('OWNER');
  });

  it('refuses a folder the caller does not own, as a 404', async () => {
    const folder = await call<{ id: string }>(harness, 'POST', '/folders', {
      user: THEO,
      body: { name: uniqueTitle('Theo folder') },
    });
    expect(folder.status).toBe(201);

    const reply = await call(harness, 'POST', '/documents', {
      user: IRIS,
      body: { title: uniqueTitle('Misfiled'), folderId: folder.body.id },
    });
    expect(reply.status).toBe(404);

    await harness.db.folder.delete({ where: { id: folder.body.id } });
  });
});

describe('the permission matrix, over HTTP', () => {
  let documentId = '';

  beforeAll(async () => {
    documentId = await own(uniqueTitle('Matrix'));
    await harness.db.documentMember.createMany({
      data: [
        { documentId, userId: THEO.id, role: 'EDITOR' },
        { documentId, userId: MARA.id, role: 'VIEWER' },
      ],
    });
  });

  it('lets an editor rename and refuses a viewer', async () => {
    const byEditor = await call(harness, 'PATCH', `/documents/${documentId}`, {
      user: THEO,
      body: { title: uniqueTitle('Renamed by Theo') },
    });
    expect(byEditor.status).toBe(200);

    const byViewer = await call(harness, 'PATCH', `/documents/${documentId}`, {
      user: MARA,
      body: { title: 'Renamed by Mara' },
    });
    // FORBIDDEN, not NOT_FOUND: Mara can read this document, so telling her it
    // does not exist would be a lie she can disprove by reloading.
    expect(byViewer.status).toBe(403);
    expect(byViewer.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  /**
   * `document.move` is `OWNER` only while `document.rename` reaches `EDITOR`.
   * That asymmetry is exactly why the matrix is written out in full rather than
   * derived from a rank: a derived one cannot express it.
   */
  it('refuses an editor moving a document, though it let them rename one', async () => {
    const reply = await call(harness, 'POST', `/documents/${documentId}/move`, {
      user: THEO,
      body: { folderId: null },
    });
    expect(reply.status).toBe(403);
  });

  it('tells a stranger the document does not exist', async () => {
    const onReal = await call(harness, 'GET', `/documents/${documentId}`, { user: STRANGER });
    const onMissing = await call(harness, 'GET', '/documents/cnosuchdocument0000000000', {
      user: STRANGER,
    });
    expect(onReal.status).toBe(404);
    expect(onMissing.status).toBe(404);
    expect(onReal.body).toEqual(onMissing.body);
  });
});

describe('soft delete', () => {
  it('takes the document away from its own owner', async () => {
    const documentId = await own(uniqueTitle('Doomed'));

    const deleted = await call<{ deletedAt: string }>(
      harness,
      'DELETE',
      `/documents/${documentId}`,
      {
        user: IRIS,
      },
    );
    expect(deleted.status).toBe(200);
    expect(Number.isNaN(Date.parse(deleted.body.deletedAt))).toBe(false);

    // The member row is still there -- nothing cleans it up, and cleaning it up
    // would make an undelete lose everybody's access. So the owner still holds
    // OWNER on this document, and every one of these must still refuse.
    const membership = await harness.db.documentMember.findUnique({
      where: { documentId_userId: { documentId, userId: IRIS.id } },
    });
    expect(membership?.role).toBe('OWNER');

    expect((await call(harness, 'GET', `/documents/${documentId}`, { user: IRIS })).status).toBe(
      404,
    );
    expect(
      (
        await call(harness, 'PATCH', `/documents/${documentId}`, {
          user: IRIS,
          body: { title: 'x' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(harness, 'POST', `/documents/${documentId}/links`, {
          user: IRIS,
          body: { role: 'VIEWER' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(harness, 'GET', `/documents/${documentId}/versions`, { user: IRIS })).status,
    ).toBe(404);
  });

  it('restores it, and only for somebody who could delete it', async () => {
    const documentId = await own(uniqueTitle('Recovered'));
    await harness.db.documentMember.create({
      data: { documentId, userId: THEO.id, role: 'EDITOR' },
    });
    await call(harness, 'DELETE', `/documents/${documentId}`, { user: IRIS });

    // An editor may not restore: `document.delete` is OWNER only, and restore is
    // the same permission because it is the same decision.
    const byEditor = await call(harness, 'POST', `/documents/${documentId}/restore`, {
      user: THEO,
    });
    expect(byEditor.status).toBe(403);

    const byOwner = await call(harness, 'POST', `/documents/${documentId}/restore`, { user: IRIS });
    expect(byOwner.status).toBe(201);
    expect((await call(harness, 'GET', `/documents/${documentId}`, { user: IRIS })).status).toBe(
      200,
    );
  });

  it('shows a deleted document only in the bin', async () => {
    const title = uniqueTitle('Binned');
    const documentId = await own(title);
    await call(harness, 'DELETE', `/documents/${documentId}`, { user: IRIS });

    const live = await call<{ documents: Array<{ id: string }> }>(harness, 'GET', '/documents', {
      user: IRIS,
    });
    const bin = await call<{ documents: Array<{ id: string }> }>(
      harness,
      'GET',
      '/documents?deleted=true',
      { user: IRIS },
    );

    expect(live.body.documents.some((document) => document.id === documentId)).toBe(false);
    expect(bin.body.documents.some((document) => document.id === documentId)).toBe(true);
  });
});

/**
 * Keyset, not `OFFSET`.
 *
 * The list is ordered by `updated_at DESC` and that column moves while somebody
 * is paging, so an offset skips rows and repeats others. This walks every page
 * and asserts the union is exactly the set, with nothing seen twice -- which is
 * the property an offset breaks and a consecutive-page assertion would not
 * notice.
 */
describe('pagination', () => {
  it('walks every page without dropping or repeating a document', async () => {
    const pageSize = Number(process.env.DOCUMENT_LIST_PAGE_SIZE ?? '25');
    const mine = new Set<string>();
    for (let i = 0; i < 3; i += 1) mine.add(await own(uniqueTitle(`Page ${String(i)}`)));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const reply: { body: { documents: Array<{ id: string }>; nextCursor: string | null } } =
        await call(
          harness,
          'GET',
          `/documents${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
          { user: IRIS },
        );
      expect(reply.body.documents.length).toBeLessThanOrEqual(pageSize);
      seen.push(...reply.body.documents.map((document) => document.id));
      cursor = reply.body.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(new Set(seen).size, 'a document appeared on two pages').toBe(seen.length);
    for (const id of mine) expect(seen, `${id} was dropped between pages`).toContain(id);
  });

  it('refuses a cursor it cannot read rather than silently restarting', async () => {
    // Restarting means a client with a stale cursor pages forever and nothing
    // says why.
    const reply = await call(harness, 'GET', '/documents?cursor=not-a-cursor', { user: IRIS });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ code: 'INVALID' });
  });
});

describe('search', () => {
  it('finds a seeded document by a word in its body', async () => {
    const reply = await call<Array<{ id: string; title: string; snippet: string }>>(
      harness,
      'GET',
      '/documents/search?q=persistence',
      { user: IRIS },
    );
    expect(reply.status).toBe(200);
    expect(reply.body.length).toBeGreaterThan(0);
    expect(reply.body.some((hit) => hit.title === 'Sync protocol notes')).toBe(true);
  });

  it('scopes hits to documents the caller is on', async () => {
    const reply = await call<Array<{ id: string }>>(
      harness,
      'GET',
      '/documents/search?q=protocol',
      {
        user: STRANGER,
      },
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual([]);
  });

  /**
   * `websearch_to_tsquery`, not `to_tsquery`. The latter raises a syntax error on
   * a bare `&`, an unbalanced quote, or the word "and" -- that is, on ordinary
   * typing in a search box. Every one of these must be a 200 with no rows rather
   * than a 500.
   */
  it.each(['a & b', '"unbalanced', 'and', 'or not', '!!!', 'zzzznope'])(
    'never raises on what a person actually types: %j',
    async (q) => {
      const reply = await call(harness, 'GET', `/documents/search?q=${encodeURIComponent(q)}`, {
        user: IRIS,
      });
      expect(reply.status).toBe(200);
      expect(Array.isArray(reply.body)).toBe(true);
    },
  );

  it('marks matches with brackets and never with HTML', async () => {
    // `content_text` is whatever somebody typed into a document. A snippet in
    // `<b>` format would put author text and server markup in one string with no
    // way to tell them apart.
    const reply = await call<Array<{ snippet: string }>>(
      harness,
      'GET',
      '/documents/search?q=persistence',
      { user: IRIS },
    );
    const snippets = reply.body.map((hit) => hit.snippet).join(' ');
    expect(snippets).not.toContain('<b>');
    expect(snippets).toContain('[[');
  });

  it('refuses an empty query at the contract rather than issuing it', async () => {
    expect((await call(harness, 'GET', '/documents/search?q=', { user: IRIS })).status).toBe(400);
  });
});
