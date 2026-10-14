import { VERSION_N_UNIQUE } from '@docs/db';
import { DOCUMENT_FRAGMENT, encodeState, type DocumentRepository } from '@docs/doc-store';
import { isDomainError } from '@docs/shared';
import type { LastVersion } from '@docs/versioning';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { VersionStore } from './persistence.js';
import { computeDiff, cutManualVersion, type DiffSources } from './versions.js';

const DOCUMENT = 'cdocsync00000000000000000';

function stateOf(...paragraphs: string[]): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  try {
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
    for (const text of paragraphs) {
      const element = new Y.XmlElement('paragraph');
      fragment.insert(fragment.length, [element]);
      element.insert(0, [new Y.XmlText(text)]);
    }
    return encodeState(doc);
  } finally {
    doc.destroy();
  }
}

function sources(overrides: Partial<DiffSources> = {}): DiffSources {
  return {
    versionState: async (_documentId, n) =>
      n === 1
        ? stateOf('the append path')
        : n === 2
          ? stateOf('the append path', 'the replay path')
          : null,
    liveState: async () => stateOf('the append path', 'the replay path', 'the compaction path'),
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'did not throw';
  } catch (error) {
    return isDomainError(error) ? error.code : `not a DomainError: ${String(error)}`;
  }
}

describe('computeDiff', () => {
  it('diffs two versions at the line level', async () => {
    const diff = await computeDiff({ documentId: DOCUMENT, from: 1, to: 2 }, sources());
    expect(diff.from).toBe(1);
    expect(diff.to).toBe(2);
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(0);
    expect(diff.lines).toEqual([
      { kind: 'unchanged', text: 'the append path' },
      { kind: 'added', text: 'the replay path' },
    ]);
  });

  it('diffs a version against the live document when `to` is null', async () => {
    // Against the live document, which is checkpoint plus log -- not against the
    // last checkpoint, which on a busy document is several paragraphs behind.
    const diff = await computeDiff({ documentId: DOCUMENT, from: 1, to: null }, sources());
    expect(diff.to).toBeNull();
    expect(diff.addedLines).toBe(2);
  });

  it('is NOT_FOUND for a version number that does not exist', async () => {
    expect(await codeOf(computeDiff({ documentId: DOCUMENT, from: 9, to: 1 }, sources()))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(computeDiff({ documentId: DOCUMENT, from: 1, to: 9 }, sources()))).toBe(
      'NOT_FOUND',
    );
  });

  it('is NOT_FOUND when the live document has gone', async () => {
    expect(
      await codeOf(
        computeDiff(
          { documentId: DOCUMENT, from: 1, to: null },
          sources({ liveState: async () => null }),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses to compare a version with itself', async () => {
    // An empty diff rendered as "no changes" would be indistinguishable from two
    // genuinely identical versions, so the request is refused rather than
    // answered ambiguously.
    expect(await codeOf(computeDiff({ documentId: DOCUMENT, from: 2, to: 2 }, sources()))).toBe(
      'INVALID',
    );
  });

  it('reads the earlier version before the later one, and stops on the first miss', async () => {
    // So a request for a version that does not exist does not also materialise a
    // document it will throw away.
    let reads = 0;
    await codeOf(
      computeDiff(
        { documentId: DOCUMENT, from: 9, to: 2 },
        sources({
          versionState: async (_documentId, n) => {
            reads += 1;
            return n === 2 ? stateOf('x') : null;
          },
        }),
      ),
    );
    expect(reads).toBe(1);
  });

  it('reports no change between two versions holding the same text', async () => {
    const diff = await computeDiff(
      { documentId: DOCUMENT, from: 1, to: 2 },
      sources({ versionState: async () => stateOf('unchanged') }),
    );
    expect(diff.addedLines).toBe(0);
    expect(diff.removedLines).toBe(0);
    expect(diff.lines).toEqual([{ kind: 'unchanged', text: 'unchanged' }]);
  });
});

/**
 * Cutting a version by hand.
 *
 * The store and the repository are fakes, so this is a gate test: no database,
 * no Hocuspocus, no socket. What it holds shut is everything about the write
 * that a database would not catch on its own -- where the bytes come from, what
 * the label becomes, what happens when two people press Save at the same instant,
 * and that a prune never eats the version it was called about.
 */
describe('cutManualVersion', () => {
  const POLICY = { intervalSeconds: 300, maxPerDocument: 3 };
  const AUTHOR = { authorId: 'cuseriris0000000000000000', authorName: 'Iris Almeida' };

  interface Row {
    id: string;
    n: number;
    kind: 'AUTO' | 'MANUAL';
    label: string | null;
    state: Uint8Array;
    authorId: string | null;
    createdAt: Date;
  }

  class FakeStore implements VersionStore {
    rows: Row[] = [];
    deleted: string[] = [];
    /** Numbers to refuse once, simulating the loser of a race on `(document_id, n)`. */
    collideOn: number[] = [];

    async lastVersion(): Promise<(LastVersion & { n: number }) | null> {
      const last = [...this.rows].sort((a, b) => a.n - b.n).at(-1);
      return last === undefined
        ? null
        : { n: last.n, createdAt: last.createdAt, fingerprint: `fp-${String(last.n)}` };
    }

    async createVersion(input: {
      documentId: string;
      n: number;
      state: Uint8Array;
      kind: 'AUTO' | 'MANUAL';
      label: string | null;
      authorId: string | null;
    }): Promise<{ id: string; createdAt: Date }> {
      const collideIndex = this.collideOn.indexOf(input.n);
      if (collideIndex >= 0) {
        this.collideOn.splice(collideIndex, 1);
        // The shape `$queryRaw` produces, which is the one the classifier has to
        // read: no `code`, only the SQLSTATE and the constraint name in the text.
        this.rows.push({
          id: `race-${String(input.n)}`,
          n: input.n,
          kind: 'AUTO',
          label: null,
          state: new Uint8Array(2),
          authorId: null,
          createdAt: new Date(0),
        });
        throw new Error(
          `23505 duplicate key value violates unique constraint "${VERSION_N_UNIQUE}"`,
        );
      }

      const row: Row = {
        id: `v${String(input.n)}`,
        n: input.n,
        kind: input.kind,
        label: input.label,
        state: input.state,
        authorId: input.authorId,
        createdAt: new Date('2026-08-26T09:30:00.000Z'),
      };
      this.rows.push(row);
      return { id: row.id, createdAt: row.createdAt };
    }

    async listForPrune(): Promise<Array<{ id: string; n: number; kind: 'AUTO' | 'MANUAL' }>> {
      return this.rows.map((row) => ({ id: row.id, n: row.n, kind: row.kind }));
    }

    async deleteVersions(ids: readonly string[]): Promise<void> {
      this.deleted.push(...ids);
      this.rows = this.rows.filter((row) => !ids.includes(row.id));
    }
  }

  /** Only the two methods `loadDocument` calls. */
  function repository(state: Uint8Array | null): DocumentRepository {
    return {
      loadSnapshot: async () => (state === null ? null : { state, stateSeq: 0n, nextSeq: 1n }),
      loadUpdates: async () => [],
    } as unknown as DocumentRepository;
  }

  function deps(store: FakeStore, state: Uint8Array | null = stateOf('the append path')) {
    return { versions: store, repository: repository(state), policy: POLICY };
  }

  it('writes the state the repository holds, and answers with the row', async () => {
    const store = new FakeStore();
    const state = stateOf('the append path', 'the replay path');

    const summary = await cutManualVersion(
      { documentId: DOCUMENT, label: 'Before the rewrite', ...AUTHOR },
      deps(store, state),
    );

    expect(summary).toEqual({
      id: 'v1',
      n: 1,
      kind: 'MANUAL',
      label: 'Before the rewrite',
      authorName: 'Iris Almeida',
      createdAt: '2026-08-26T09:30:00.000Z',
      bytes: state.byteLength,
    });
    expect(store.rows[0]?.state).toEqual(state);
    expect(store.rows[0]?.authorId).toBe(AUTHOR.authorId);
  });

  /**
   * A version is something a restore can return to, and a restore reads what was
   * written. Taking the live in-memory document instead would let somebody save a
   * version containing an update that had not reached Postgres.
   */
  it('reads the state through the repository rather than from anywhere else', async () => {
    const store = new FakeStore();
    let asked = 0;
    const counting = {
      loadSnapshot: async () => {
        asked += 1;
        return { state: stateOf('from the log'), stateSeq: 0n, nextSeq: 1n };
      },
      loadUpdates: async () => [],
    } as unknown as DocumentRepository;

    await cutManualVersion(
      { documentId: DOCUMENT, label: 'x', ...AUTHOR },
      {
        versions: store,
        repository: counting,
        policy: POLICY,
      },
    );
    expect(asked).toBe(1);
    expect(store.rows[0]?.state).toEqual(stateOf('from the log'));
  });

  it('refuses a document that is not there', async () => {
    const store = new FakeStore();
    expect(
      await codeOf(
        cutManualVersion({ documentId: DOCUMENT, label: 'x', ...AUTHOR }, deps(store, null)),
      ),
    ).toBe('NOT_FOUND');
    expect(store.rows).toHaveLength(0);
  });

  /**
   * Normalised before the row is written, not at render time. Storing the raw
   * string and normalising in the panel means the database holds one label and
   * the screen shows another, and a search for what is on screen finds nothing.
   */
  it('normalises the label before storing it', async () => {
    const store = new FakeStore();
    const summary = await cutManualVersion(
      { documentId: DOCUMENT, label: '  Before   the\trewrite  ', ...AUTHOR },
      deps(store),
    );
    expect(summary.label).toBe('Before the rewrite');
    expect(store.rows[0]?.label).toBe('Before the rewrite');
  });

  it.each([['   '], ['x'.repeat(81)], ['bad\u200bzero-width']])(
    'refuses a label a person could not recognise later: %j',
    async (label) => {
      const store = new FakeStore();
      expect(
        await codeOf(cutManualVersion({ documentId: DOCUMENT, label, ...AUTHOR }, deps(store))),
      ).toBe('INVALID');
      expect(store.rows).toHaveLength(0);
    },
  );

  /**
   * Two people pressing Save in the same instant compute the same `n` and one of
   * them loses on `UNIQUE (document_id, n)`. That is the design -- a global
   * sequence would make a user-visible "version 7" jump to 9 because somebody
   * saved a different document -- so the loser retries and takes the next number.
   */
  it('retries onto the next number when another writer took this one', async () => {
    const store = new FakeStore();
    store.collideOn = [1];

    const summary = await cutManualVersion(
      { documentId: DOCUMENT, label: 'mine', ...AUTHOR },
      deps(store),
    );
    expect(summary.n).toBe(2);
    expect(store.rows.map((row) => row.n)).toEqual([1, 2]);
  });

  it('gives up rather than looping when the collision does not clear', async () => {
    const store = new FakeStore();
    // Three collisions, one per attempt, so every retry is used.
    store.collideOn = [1, 2, 3];
    await expect(
      cutManualVersion({ documentId: DOCUMENT, label: 'mine', ...AUTHOR }, deps(store)),
    ).rejects.toThrow(/23505/u);
  });

  it('does not retry an error that is not a version-number collision', async () => {
    const store = new FakeStore();
    let calls = 0;
    store.createVersion = async () => {
      calls += 1;
      throw new Error('connect ECONNREFUSED 127.0.0.1:5440');
    };
    await expect(
      cutManualVersion({ documentId: DOCUMENT, label: 'mine', ...AUTHOR }, deps(store)),
    ).rejects.toThrow(/ECONNREFUSED/u);
    expect(calls).toBe(1);
  });

  /**
   * The prune runs after the write, and the row just written is over the cap by
   * definition. Excluding it is what stops "save a version" from meaning "save a
   * version and immediately delete it".
   */
  it('never prunes the version it just cut', async () => {
    const store = new FakeStore();
    for (const n of [1, 2, 3]) {
      store.rows.push({
        id: `v${String(n)}`,
        n,
        kind: 'AUTO',
        label: null,
        state: new Uint8Array(2),
        authorId: null,
        createdAt: new Date(n),
      });
    }

    const summary = await cutManualVersion(
      { documentId: DOCUMENT, label: 'mine', ...AUTHOR },
      deps(store),
    );

    expect(summary.n).toBe(4);
    expect(store.rows.some((row) => row.id === summary.id)).toBe(true);
    // maxPerDocument is 3 and there were 4 rows, so exactly the oldest automatic
    // one goes.
    expect(store.deleted).toEqual(['v1']);
  });

  it('leaves a labelled version alone even when the cap is exceeded', async () => {
    const store = new FakeStore();
    for (const n of [1, 2, 3]) {
      store.rows.push({
        id: `v${String(n)}`,
        n,
        kind: 'MANUAL',
        label: `kept ${String(n)}`,
        state: new Uint8Array(2),
        authorId: null,
        createdAt: new Date(n),
      });
    }

    await cutManualVersion({ documentId: DOCUMENT, label: 'mine', ...AUTHOR }, deps(store));
    expect(store.deleted).toEqual([]);
    expect(store.rows).toHaveLength(4);
  });
});
