/**
 * The persistence extension, driven by calling its hooks directly.
 *
 * No websocket and no Postgres: `MemoryDocumentRepository` is doc-store's own
 * in-memory twin of the port, so every branch here runs in the free lane. What
 * this file cannot prove is that Hocuspocus calls these hooks in the order the
 * module header claims -- that is `hocuspocus-contract.test.ts`, and the
 * cross-replica and `kill -9` behaviour is the integration lane.
 */
import {
  DOCUMENT_FRAGMENT,
  LOAD_ORIGIN,
  MemoryDocumentRepository,
  docFromState,
  documentFingerprint,
  plainTextOf,
} from '@docs/doc-store';
import type { LastVersion } from '@docs/versioning';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { Persistence, type VersionStore } from './persistence.js';

const DOCUMENT = 'cdocsync00000000000000000';
const AUTHOR = 'cuseriris0000000000000000';
const T0 = 1_800_000_000_000;

interface VersionRow {
  id: string;
  n: number;
  kind: 'AUTO' | 'MANUAL';
  state: Uint8Array;
  label: string | null;
  createdAt: Date;
  fingerprintAt: string;
}

class MemoryVersionStore implements VersionStore {
  readonly rows: VersionRow[] = [];
  deleted: string[] = [];
  /**
   * The fingerprint of a stored version, computed the way the Prisma-backed
   * store has to compute it: materialise the state and take
   * `documentFingerprint`.
   *
   * Not a constant, and not a hash of the bytes. The update format is not
   * canonical, so two encodings of one document differ byte for byte and a byte
   * hash would cut a "new" version every interval for a document nobody touched
   * -- which is precisely the behaviour `shouldCutVersion` exists to prevent, so
   * a fake that got this wrong would make the cadence test pass while the real
   * thing filled the panel.
   */
  fingerprintOf: (state: Uint8Array) => string = (state) => {
    const doc = docFromState(state);
    try {
      return documentFingerprint(doc);
    } finally {
      doc.destroy();
    }
  };
  now: () => number = () => T0;

  async lastVersion(documentId: string): Promise<(LastVersion & { n: number }) | null> {
    void documentId;
    const last = [...this.rows].sort((a, b) => a.n - b.n).at(-1);
    if (last === undefined) return null;
    return { n: last.n, createdAt: last.createdAt, fingerprint: last.fingerprintAt };
  }

  async createVersion(input: {
    documentId: string;
    n: number;
    state: Uint8Array;
    kind: 'AUTO' | 'MANUAL';
    label: string | null;
  }): Promise<{ id: string; createdAt: Date }> {
    const row = {
      id: `v${input.n}`,
      n: input.n,
      kind: input.kind,
      state: input.state,
      label: input.label,
      createdAt: new Date(this.now()),
      fingerprintAt: this.fingerprintOf(input.state),
    };
    this.rows.push(row);
    return { id: row.id, createdAt: row.createdAt };
  }

  async listForPrune(
    documentId: string,
  ): Promise<Array<{ id: string; n: number; kind: 'AUTO' | 'MANUAL' }>> {
    void documentId;
    return this.rows.map((row) => ({ id: row.id, n: row.n, kind: row.kind }));
  }

  async deleteVersions(ids: readonly string[]): Promise<void> {
    this.deleted.push(...ids);
    for (const id of ids) {
      const index = this.rows.findIndex((row) => row.id === id);
      if (index >= 0) this.rows.splice(index, 1);
    }
  }
}

let clock = T0;
let repository: MemoryDocumentRepository;
let versions: MemoryVersionStore;
const logLines: string[] = [];

function build(overrides: Partial<ConstructorParameters<typeof Persistence>[0]> = {}): Persistence {
  return new Persistence({
    repository,
    versions,
    compaction: { afterUpdates: 3, afterSeconds: 120 },
    versionPolicy: { intervalSeconds: 300, maxPerDocument: 3 },
    documentMaxBytes: 5_242_880,
    now: () => clock,
    log: (message) => logLines.push(message),
    ...overrides,
  });
}

/** The payload shape the hooks actually read. Cast once, here, rather than at ten call sites. */
function payload(document: Y.Doc): never {
  return { documentName: DOCUMENT, document } as never;
}

function type(document: Y.Doc, text: string, origin: unknown): void {
  const fragment = document.getXmlFragment(DOCUMENT_FRAGMENT);
  const element = new Y.XmlElement('paragraph');
  Y.transact(
    document,
    () => {
      fragment.insert(fragment.length, [element]);
      element.insert(0, [new Y.XmlText(text)]);
    },
    origin,
  );
}

/** A `ConnectionTransactionOrigin` carrying a context, which is what `authorOf` reads. */
function fromConnection(userId: string | null): unknown {
  return {
    source: 'connection',
    connection: { context: userId === null ? {} : { user: { id: userId } } },
  };
}

/** Let the fire-and-forget appends in the update listener settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  clock = T0;
  repository = new MemoryDocumentRepository(() => clock);
  versions = new MemoryVersionStore();
  versions.now = () => clock;
  logLines.length = 0;
});

describe('onLoadDocument', () => {
  it('applies the checkpoint and replays the log', async () => {
    repository.create(DOCUMENT);
    const writer = new Y.Doc();
    writer.clientID = 1;
    for (const text of ['first', 'second']) {
      const before = Y.encodeStateVector(writer);
      type(writer, text, 'test');
      await repository.appendUpdate(DOCUMENT, Y.encodeStateAsUpdate(writer, before), AUTHOR);
    }

    const document = new Y.Doc();
    await build().onLoadDocument(payload(document));
    expect(plainTextOf(document)).toBe('first\nsecond');
    expect(logLines.some((line) => line.includes('2 update(s) replayed'))).toBe(true);
  });

  it('leaves a document that does not exist empty rather than creating one', async () => {
    // Creating here would let any authenticated client conjure a row by naming a
    // room. A missing row at this point is a deletion that raced the connection.
    const document = new Y.Doc();
    await build().onLoadDocument(payload(document));
    expect(plainTextOf(document)).toBe('');
    expect(logLines).toContain(`load ${DOCUMENT}: no such document`);
  });
});

describe('the update listener', () => {
  it('appends what a client types', async () => {
    repository.create(DOCUMENT);
    const persistence = build();
    const document = new Y.Doc();
    await persistence.onLoadDocument(payload(document));
    await persistence.afterLoadDocument(payload(document));

    type(document, 'typed by a person', fromConnection(AUTHOR));
    await settle();

    expect(repository.logSize(DOCUMENT)).toBe(1);
    const [row] = await repository.loadUpdates(DOCUMENT, 0n);
    expect(row?.seq).toBe(1n);
  });

  it('does not re-append the replay', async () => {
    // Green because of the hook ORDER: the replay in onLoadDocument happens
    // before afterLoadDocument attaches the listener. The LOAD_ORIGIN guard is
    // not what makes this pass -- the next test is the one that needs it.
    repository.create(DOCUMENT);
    const writer = new Y.Doc();
    writer.clientID = 1;
    type(writer, 'already logged', 'test');
    await repository.appendUpdate(DOCUMENT, Y.encodeStateAsUpdate(writer), AUTHOR);

    const persistence = build();
    const document = new Y.Doc();
    await persistence.onLoadDocument(payload(document));
    await persistence.afterLoadDocument(payload(document));
    await settle();

    expect(repository.logSize(DOCUMENT)).toBe(1);
  });

  it('ignores an update the load path applies after the listener is attached', async () => {
    // The case the LOAD_ORIGIN guard actually covers, provoked directly:
    // a hydration into a document that is already being recorded. Delete the
    // guard and only this test goes red.
    repository.create(DOCUMENT);
    const persistence = build();
    const document = new Y.Doc();
    await persistence.afterLoadDocument(payload(document));

    type(document, 'hydration', LOAD_ORIGIN);
    await settle();

    expect(repository.logSize(DOCUMENT)).toBe(0);
  });

  it('does not append an update relayed from the other replica', async () => {
    // The replica that received it from a client already appended it. Appending
    // again would be correct and would double the log.
    repository.create(DOCUMENT);
    const persistence = build();
    const document = new Y.Doc();
    await persistence.afterLoadDocument(payload(document));

    type(document, 'from the other replica', { source: 'redis' });
    await settle();

    expect(repository.logSize(DOCUMENT)).toBe(0);
  });

  it('records the author from the connection context, never from the update', async () => {
    repository.create(DOCUMENT);
    const persistence = build();
    const document = new Y.Doc();
    await persistence.afterLoadDocument(payload(document));

    type(document, 'mine', fromConnection(AUTHOR));
    type(document, 'anonymous', { source: 'local' });
    await settle();

    expect(repository.logSize(DOCUMENT)).toBe(2);
  });

  it('stops recording when the document unloads', async () => {
    // A listener left attached holds the Y.Doc alive, so a server that has seen
    // a thousand documents is holding a thousand of them.
    repository.create(DOCUMENT);
    const persistence = build();
    const document = new Y.Doc();
    await persistence.afterLoadDocument(payload(document));
    await persistence.beforeUnloadDocument(payload(document));

    type(document, 'after unload', fromConnection(AUTHOR));
    await settle();

    expect(repository.logSize(DOCUMENT)).toBe(0);
  });

  it('attaches exactly one listener however often afterLoadDocument runs', async () => {
    repository.create(DOCUMENT);
    const persistence = build();
    const document = new Y.Doc();
    await persistence.afterLoadDocument(payload(document));
    await persistence.afterLoadDocument(payload(document));

    type(document, 'once', fromConnection(AUTHOR));
    await settle();

    expect(repository.logSize(DOCUMENT)).toBe(1);
  });

  it('records a document reloaded while its previous instance is still unloading', async () => {
    // The race CI found: every client leaves, Hocuspocus starts unloading the
    // Y.Doc after its store debounce, and a new client connects inside that
    // window. A new Y.Doc is loaded under the SAME name before the old one's
    // beforeUnloadDocument has run. Keyed by name, afterLoadDocument saw the
    // old entry, attached nothing to the new document, and every update to it
    // was applied, broadcast -- and never written to the log.
    repository.create(DOCUMENT);
    const persistence = build();
    const leaving = new Y.Doc();
    await persistence.afterLoadDocument(payload(leaving));

    const arriving = new Y.Doc();
    await persistence.onLoadDocument(payload(arriving));
    await persistence.afterLoadDocument(payload(arriving));
    type(arriving, 'typed during the reload', fromConnection(AUTHOR));
    await settle();

    expect(repository.logSize(DOCUMENT)).toBe(1);
  });

  it('keeps recording the new instance after the old one finishes unloading', async () => {
    // The other half of the same race: the old instance's beforeUnloadDocument
    // arrives last and must detach only ITS listener, not the new document's.
    repository.create(DOCUMENT);
    const persistence = build();
    const leaving = new Y.Doc();
    await persistence.afterLoadDocument(payload(leaving));
    const arriving = new Y.Doc();
    await persistence.afterLoadDocument(payload(arriving));
    await persistence.beforeUnloadDocument(payload(leaving));

    type(arriving, 'after the old instance left', fromConnection(AUTHOR));
    type(leaving, 'the old instance is gone', fromConnection(AUTHOR));
    await settle();

    expect(repository.logSize(DOCUMENT)).toBe(1);
  });
});

describe('onStoreDocument', () => {
  async function loadedWith(
    texts: string[],
  ): Promise<{ persistence: Persistence; document: Y.Doc }> {
    repository.create(DOCUMENT);
    const persistence = build();
    const document = new Y.Doc();
    document.clientID = 7;
    await persistence.onLoadDocument(payload(document));
    await persistence.afterLoadDocument(payload(document));
    for (const text of texts) type(document, text, fromConnection(AUTHOR));
    await settle();
    return { persistence, document };
  }

  it('does not compact below the threshold', async () => {
    const { persistence, document } = await loadedWith(['one', 'two']);
    await persistence.onStoreDocument(payload(document));
    expect(repository.logSize(DOCUMENT)).toBe(2);
  });

  it('compacts once the log passes the threshold, and truncates what it folded in', async () => {
    const { persistence, document } = await loadedWith(['one', 'two', 'three']);
    await persistence.onStoreDocument(payload(document));
    expect(repository.logSize(DOCUMENT)).toBe(0);
    expect(repository.contentText(DOCUMENT)).toBe('one\ntwo\nthree');
  });

  it('leaves the document identical across a compaction', async () => {
    const { persistence, document } = await loadedWith(['one', 'two', 'three']);
    await persistence.onStoreDocument(payload(document));

    const reloaded = new Y.Doc();
    await build().onLoadDocument(payload(reloaded));
    expect(plainTextOf(reloaded)).toBe(plainTextOf(document));
  });

  it('refuses to compact a document whose append failed', async () => {
    // The in-memory document is ahead of the log. A checkpoint taken here would
    // claim an update that was never durably written, and the truncation that
    // follows would delete rows around the hole.
    repository.create(DOCUMENT);
    const persistence = build();
    const document = new Y.Doc();
    await persistence.afterLoadDocument(payload(document));

    type(document, 'one', fromConnection(AUTHOR));
    type(document, 'two', fromConnection(AUTHOR));
    await settle();
    // A document id the repository has never heard of makes the next append throw.
    const broken = build();
    const orphan = new Y.Doc();
    await broken.afterLoadDocument({
      documentName: 'cdocgone00000000000000000',
      document: orphan,
    } as never);
    type(orphan, 'into the void', fromConnection(AUTHOR));
    await settle();
    await broken.onStoreDocument({
      documentName: 'cdocgone00000000000000000',
      document: orphan,
    } as never);

    expect(logLines.some((line) => line.includes('the log has a hole'))).toBe(true);
  });
});

describe('version cadence', () => {
  async function loaded(): Promise<{ persistence: Persistence; document: Y.Doc }> {
    repository.create(DOCUMENT);
    const persistence = build();
    const document = new Y.Doc();
    document.clientID = 9;
    await persistence.onLoadDocument(payload(document));
    await persistence.afterLoadDocument(payload(document));
    return { persistence, document };
  }

  it('cuts the first version of a document', async () => {
    const { persistence, document } = await loaded();
    type(document, 'first words', fromConnection(AUTHOR));
    await settle();
    await persistence.onStoreDocument(payload(document));
    expect(versions.rows.map((row) => row.n)).toEqual([1]);
    expect(versions.rows[0]?.kind).toBe('AUTO');
    expect(versions.rows[0]?.label).toBeNull();
  });

  it('gives an automatic version no author', async () => {
    // It records the document, not a decision. Attributing it to whoever typed
    // last puts a name against a cut they did not ask for.
    const { persistence, document } = await loaded();
    type(document, 'first words', fromConnection(AUTHOR));
    await settle();
    await persistence.onStoreDocument(payload(document));
    expect(versions.rows).toHaveLength(1);
  });

  it('does not cut a second version inside the interval', async () => {
    const { persistence, document } = await loaded();
    type(document, 'one', fromConnection(AUTHOR));
    await settle();
    await persistence.onStoreDocument(payload(document));

    clock = T0 + 299_000;
    type(document, 'two', fromConnection(AUTHOR));
    await settle();
    await persistence.onStoreDocument(payload(document));
    expect(versions.rows).toHaveLength(1);
  });

  it('cuts once the interval has passed and the document moved', async () => {
    const { persistence, document } = await loaded();
    type(document, 'one', fromConnection(AUTHOR));
    await settle();
    await persistence.onStoreDocument(payload(document));

    clock = T0 + 300_000;
    type(document, 'two', fromConnection(AUTHOR));
    await settle();
    await persistence.onStoreDocument(payload(document));
    expect(versions.rows.map((row) => row.n)).toEqual([1, 2]);
  });

  it('does not cut a version of a document nobody changed', async () => {
    const { persistence, document } = await loaded();
    type(document, 'one', fromConnection(AUTHOR));
    await settle();
    await persistence.onStoreDocument(payload(document));

    clock = T0 + 86_400_000;
    await persistence.onStoreDocument(payload(document));
    expect(versions.rows).toHaveLength(1);
  });

  it('prunes the oldest automatic versions past the cap, never a labelled one', async () => {
    const { persistence, document } = await loaded();
    for (let i = 0; i < 5; i += 1) {
      clock = T0 + i * 300_000;
      type(document, `paragraph ${i}`, fromConnection(AUTHOR));
      await settle();
      // Version 2 is one somebody named, so the pruner must keep it.
      if (versions.rows.length === 1) versions.rows[0]!.kind = 'MANUAL';
      await persistence.onStoreDocument(payload(document));
    }
    expect(versions.rows).toHaveLength(3);
    expect(versions.rows.some((row) => row.kind === 'MANUAL')).toBe(true);
    expect(versions.rows[0]?.n).toBe(1);
  });
});
