/**
 * What `@hocuspocus/server@4.6.0` actually does, pinned.
 *
 * `persistence.ts` is built on three claims about the library, and all three are
 * invisible from our own code: the hydration in `onLoadDocument` does not reach
 * `onChange`; `afterLoadDocument` runs after the library has attached its own
 * update listener; and a relayed update is discriminable by its transaction
 * origin. If a future version changes any of them, our extension silently starts
 * appending its own replay -- which is not a crash, it is a log that doubles
 * every time somebody opens a document.
 *
 * Run through `openDirectConnection`, so there is no socket, no port and no
 * network: this belongs in the free lane, not the integration one.
 */
import { MemoryDocumentRepository, plainTextOf } from '@docs/doc-store';
import { Hocuspocus, defaultConfiguration, isTransactionOrigin } from '@hocuspocus/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { Persistence, type VersionStore } from './persistence.js';

const DOCUMENT = 'cdoctest00000000000000000';

const openServers: Hocuspocus[] = [];

function server(extensions: Array<Record<string, unknown>>): Hocuspocus {
  const instance = new Hocuspocus({ quiet: true, extensions: extensions as never });
  openServers.push(instance);
  return instance;
}

afterEach(async () => {
  // A Hocuspocus that keeps a document loaded keeps a debounce timer, and vitest
  // then reports open handles rather than failing anything.
  for (const instance of openServers.splice(0)) {
    for (const document of [...instance.documents.values()])
      await instance.unloadDocument(document);
  }
});

/** One macrotask, which is what the library's own await chains settle within. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('hook order', () => {
  it('runs onLoadDocument, then afterLoadDocument, and only then reports changes', async () => {
    const order: string[] = [];
    const instance = server([
      {
        extensionName: 'probe',
        async onLoadDocument(payload: { document: Y.Doc }) {
          order.push('onLoadDocument');
          // The hydration. If this reached onChange, our own listener would too,
          // and every load would re-append the whole log.
          payload.document.getText('body').insert(0, 'hydrated ');
        },
        async afterLoadDocument() {
          order.push('afterLoadDocument');
        },
        async onChange() {
          order.push('onChange');
        },
      },
    ]);

    const direct = await instance.openDirectConnection(DOCUMENT);
    await direct.transact((document) => {
      document.getText('body').insert(0, 'typed ');
    });
    await settle();
    await direct.disconnect();

    expect(order).toEqual(['onLoadDocument', 'afterLoadDocument', 'onChange']);
  });

  it('gives a hydration in onLoadDocument no onChange at all', async () => {
    // Stated separately from the ordering, because "the mutation happened and
    // produced no event" is the property; an ordering assertion would still pass
    // if the library fired onChange three times before afterLoadDocument.
    let changes = 0;
    const instance = server([
      {
        extensionName: 'probe',
        async onLoadDocument(payload: { document: Y.Doc }) {
          payload.document.getText('body').insert(0, 'a');
          payload.document.getText('body').insert(0, 'b');
          payload.document.getText('body').insert(0, 'c');
        },
        async onChange() {
          changes += 1;
        },
      },
    ]);

    const direct = await instance.openDirectConnection(DOCUMENT);
    await settle();
    await direct.disconnect();

    expect(changes).toBe(0);
  });
});

describe('transaction origins', () => {
  it('labels a DirectConnection write as local, and the label is discriminable', async () => {
    const origins: unknown[] = [];
    const instance = server([
      {
        extensionName: 'probe',
        async onChange(payload: { transactionOrigin: unknown }) {
          origins.push(payload.transactionOrigin);
        },
      },
    ]);

    const direct = await instance.openDirectConnection(DOCUMENT);
    await direct.transact((document) => {
      document.getText('body').insert(0, 'x');
    });
    await settle();
    await direct.disconnect();

    expect(origins).toHaveLength(1);
    expect(isTransactionOrigin(origins[0])).toBe(true);
    expect((origins[0] as { source: string }).source).toBe('local');
  });

  it('rejects a plain object as a transaction origin', () => {
    // `isTransactionOrigin` is the guard `persistence.ts` uses before reading
    // `.source`. If it accepted anything, a Yjs origin set by an unrelated
    // library would be read as a relay and the update would be dropped.
    expect(isTransactionOrigin({ notASource: true })).toBe(false);
    expect(isTransactionOrigin('doc-store:load')).toBe(false);
    expect(isTransactionOrigin(null)).toBe(false);
  });
});

describe('the Persistence extension inside a real Hocuspocus', () => {
  function versionStore(): VersionStore {
    return {
      async lastVersion() {
        return null;
      },
      async createVersion() {
        // The cadence has its own tests; this file is about the wiring.
        return { id: 'contract-version', createdAt: new Date(0) };
      },
      async listForPrune() {
        return [];
      },
      async deleteVersions() {
        /* nothing to prune */
      },
    };
  }

  it('loads a checkpoint, records what is typed, and does not record the load', async () => {
    const repository = new MemoryDocumentRepository();
    repository.create(DOCUMENT);

    // A log with something already in it, so a re-append would be visible.
    const writer = new Y.Doc();
    writer.clientID = 1;
    writer.getText('body').insert(0, 'already logged. ');
    await repository.appendUpdate(DOCUMENT, Y.encodeStateAsUpdate(writer), null);

    const persistence = new Persistence({
      repository,
      versions: versionStore(),
      // High enough that nothing compacts here: this test is about the log.
      compaction: { afterUpdates: 1000, afterSeconds: 100_000 },
      versionPolicy: { intervalSeconds: 300, maxPerDocument: 50 },
      documentMaxBytes: 5_242_880,
      log: () => {
        /* quiet */
      },
    });

    const instance = server([persistence as unknown as Record<string, unknown>]);
    const direct = await instance.openDirectConnection(DOCUMENT);
    await direct.transact((document) => {
      const body = document.getText('body');
      body.insert(body.length, 'typed by a person.');
    });
    await settle();

    // One row from the seeded log, one from the edit. Not three: the replay of
    // the first row must not have been appended back.
    expect(repository.logSize(DOCUMENT)).toBe(2);
    expect(repository.allSeqs(DOCUMENT)).toEqual([1n, 2n]);

    const reloaded = new Y.Doc();
    await persistence.onLoadDocument({ documentName: DOCUMENT, document: reloaded } as never);
    expect(reloaded.getText('body').toString()).toBe('already logged. typed by a person.');
    // This document is a Y.Text, not the XmlFragment TipTap binds to, so the
    // plain-text projection is empty. Asserted rather than left implicit,
    // because a projection that silently read something else would make the
    // search index quietly wrong for every real document.
    expect(plainTextOf(reloaded)).toBe('');

    await direct.disconnect();
  });
});

describe('the configuration this server depends on', () => {
  it('still debounces onStoreDocument, which is why compaction lives there', () => {
    // If the default became 0, every keystroke would trigger a compaction check:
    // a Postgres round trip per character.
    expect(typeof defaultConfiguration.debounce).toBe('number');
    expect(defaultConfiguration.debounce).toBeGreaterThan(0);
    expect(defaultConfiguration.maxDebounce).toBeGreaterThanOrEqual(defaultConfiguration.debounce);
  });

  it('runs documents with garbage collection ON, which is the version-history decision', () => {
    // docs/SPECS.md 5.3: gc on means bounded storage and a text-level diff. If a
    // future default flipped this to false, storage would grow with everything
    // ever typed and nothing would fail.
    expect(defaultConfiguration.yDocOptions.gc).toBe(true);
  });
});
