import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { planCompaction, shouldCompact, assertCompactionPolicy } from './compaction.js';
import { sameState } from './equality.js';
import { CompactionInterrupted, MemoryDocumentRepository } from './memory-repository.js';
import type { CompactionPolicy } from './compaction.js';
import { applyLog } from './replay.js';
import { DOCUMENT_FRAGMENT, emptyDocumentState, encodeState } from './state.js';

const POLICY: CompactionPolicy = { afterUpdates: 5, afterSeconds: 60 };
const DOC = 'doc-1';

function paragraph(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
  const element = new Y.XmlElement('paragraph');
  element.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [element]);
}

/**
 * A document being edited through the repository, exactly the way the sync
 * server drives it: every local update is appended synchronously.
 */
async function typeInto(
  repository: MemoryDocumentRepository,
  doc: Y.Doc,
  lines: readonly string[],
): Promise<void> {
  const pending: Uint8Array[] = [];
  const listener = (update: Uint8Array, origin: unknown) => {
    if (origin === 'doc-store:load') return;
    pending.push(update);
  };
  doc.on('update', listener);
  for (const line of lines) paragraph(doc, line);
  doc.off('update', listener);
  for (const update of pending) await repository.appendUpdate(DOC, update, null);
}

describe('shouldCompact', () => {
  const now = Date.UTC(2026, 7, 25, 12, 0, 0);

  it('never fires with an empty log', () => {
    expect(shouldCompact({ count: 0, oldestAt: null }, POLICY, now)).toBe(false);
  });

  it('fires on the row count', () => {
    expect(shouldCompact({ count: 4, oldestAt: new Date(now) }, POLICY, now)).toBe(false);
    expect(shouldCompact({ count: 5, oldestAt: new Date(now) }, POLICY, now)).toBe(true);
  });

  it('fires on age, which is the trigger a slowly-edited document ever reaches', () => {
    // One update an hour never reaches the count. Without this branch it would
    // replay its whole log on every load, forever.
    const old = new Date(now - 60_000);
    expect(shouldCompact({ count: 1, oldestAt: old }, POLICY, now)).toBe(true);
    expect(shouldCompact({ count: 1, oldestAt: new Date(now - 59_999) }, POLICY, now)).toBe(false);
  });

  it('takes the clock as a parameter, so the age branch needs no sleep', () => {
    const pending = { count: 1, oldestAt: new Date(now) };
    expect(shouldCompact(pending, POLICY, now)).toBe(false);
    expect(shouldCompact(pending, POLICY, now + 60_000)).toBe(true);
  });
});

describe('assertCompactionPolicy', () => {
  it('refuses a policy that would compact on every keystroke or never', () => {
    expect(() => assertCompactionPolicy({ afterUpdates: 0, afterSeconds: 60 })).toThrow();
    expect(() => assertCompactionPolicy({ afterUpdates: 5, afterSeconds: 0 })).toThrow();
    expect(() => assertCompactionPolicy({ afterUpdates: 1.5, afterSeconds: 60 })).toThrow();
    expect(() => assertCompactionPolicy(POLICY)).not.toThrow();
  });
});

describe('planCompaction', () => {
  it('returns null when there is nothing to fold in', () => {
    // So a caller cannot write a checkpoint that advances nothing and truncates
    // nothing, which would be a pure write amplification with no way to notice.
    const doc = new Y.Doc();
    expect(planCompaction(DOC, doc, [])).toBeNull();
    doc.destroy();
  });

  it('takes the highest seq among the rows it was given, not the last', () => {
    const doc = new Y.Doc();
    const plan = planCompaction(DOC, doc, [
      { seq: 7n, update: new Uint8Array([0, 0]) },
      { seq: 3n, update: new Uint8Array([0, 0]) },
      { seq: 5n, update: new Uint8Array([0, 0]) },
    ]);
    expect(plan?.stateSeq).toBe(7n);
    doc.destroy();
  });

  it('projects the plain text for the search index', () => {
    const doc = new Y.Doc();
    paragraph(doc, 'The nightly batch has been the reconciliation path.');
    const plan = planCompaction(DOC, doc, [{ seq: 1n, update: new Uint8Array([0, 0]) }]);
    expect(plan?.contentText).toContain('nightly batch');
    doc.destroy();
  });
});

describe('a compaction round trip', () => {
  it('leaves the document identical and truncates only what it folded in', async () => {
    const repository = new MemoryDocumentRepository();
    repository.create(DOC);

    const doc = new Y.Doc();
    doc.clientID = 1;
    await typeInto(repository, doc, ['one', 'two', 'three', 'four']);
    const before = encodeState(doc);
    expect(repository.logSize(DOC)).toBe(4);

    const folded = await repository.loadUpdates(DOC, 0n);
    const plan = planCompaction(DOC, doc, folded);
    await repository.compact(plan!);

    expect(repository.logSize(DOC)).toBe(0);
    expect(repository.contentText(DOC)).toContain('three');

    // Reload from nothing but the repository.
    const reloaded = new Y.Doc();
    const snapshot = await repository.loadSnapshot(DOC);
    applyLog(reloaded, snapshot!, await repository.loadUpdates(DOC, snapshot!.stateSeq));
    expect(sameState(encodeState(reloaded), before)).toBe(true);
    doc.destroy();
    reloaded.destroy();
  });

  it('does not delete a row that arrived after the plan was made', async () => {
    // The real race: the other sync replica appends while this one is
    // compacting. planCompaction takes its stateSeq from the rows it was GIVEN,
    // so the late row survives. If it took the document's highest allocated seq
    // instead, the truncation would delete a row this checkpoint does not
    // contain, and the document would silently lose it.
    const repository = new MemoryDocumentRepository();
    repository.create(DOC);

    const doc = new Y.Doc();
    doc.clientID = 1;
    await typeInto(repository, doc, ['one', 'two']);
    const folded = await repository.loadUpdates(DOC, 0n);
    const plan = planCompaction(DOC, doc, folded);

    // The other replica writes between the read and the compaction.
    const other = new Y.Doc();
    other.clientID = 2;
    Y.applyUpdate(other, encodeState(doc));
    const late: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => late.push(u));
    paragraph(other, 'written by the other replica');
    for (const update of late) await repository.appendUpdate(DOC, update, null);

    await repository.compact(plan!);

    expect(repository.allSeqs(DOC)).toEqual([3n]);

    const reloaded = new Y.Doc();
    const snapshot = await repository.loadSnapshot(DOC);
    applyLog(reloaded, snapshot!, await repository.loadUpdates(DOC, snapshot!.stateSeq));
    expect(reloaded.getXmlFragment(DOCUMENT_FRAGMENT).toString()).toContain('other replica');
    doc.destroy();
    other.destroy();
    reloaded.destroy();
  });
});

describe('the crash window', () => {
  it('loses nothing when the process dies between the checkpoint and the truncation', async () => {
    // The window the whole persistence design turns on. docs/SPECS.md 3.2:
    // the checkpoint is durable, the rows it superseded are still in the log,
    // and the next load replays updates that are already inside the checkpoint.
    // Yjs updates are idempotent, so the result is the same document.
    const repository = new MemoryDocumentRepository();
    repository.create(DOC);

    const doc = new Y.Doc();
    doc.clientID = 1;
    await typeInto(repository, doc, ['one', 'two', 'three']);
    const before = encodeState(doc);

    const folded = await repository.loadUpdates(DOC, 0n);
    const plan = planCompaction(DOC, doc, folded);

    repository.failAfterWrite = true;
    await expect(repository.compact(plan!)).rejects.toBeInstanceOf(CompactionInterrupted);

    // The checkpoint landed; the log was NOT truncated.
    const snapshot = await repository.loadSnapshot(DOC);
    expect(snapshot!.stateSeq).toBe(3n);
    expect(repository.logSize(DOC)).toBe(3);

    // loadUpdates asks for everything ABOVE stateSeq, so the ordinary load path
    // skips them. Force the pathological case anyway: replay the whole log on
    // top of the checkpoint that already contains it.
    const reloaded = new Y.Doc();
    applyLog(reloaded, snapshot!, await repository.loadUpdates(DOC, 0n));
    expect(sameState(encodeState(reloaded), before)).toBe(true);

    doc.destroy();
    reloaded.destroy();
  });

  it('loses nothing when the process dies before the checkpoint is written', async () => {
    const repository = new MemoryDocumentRepository();
    repository.create(DOC);
    const doc = new Y.Doc();
    doc.clientID = 1;
    await typeInto(repository, doc, ['one', 'two', 'three']);
    const before = encodeState(doc);

    // No compaction at all: the process died first.
    const reloaded = new Y.Doc();
    const snapshot = await repository.loadSnapshot(DOC);
    expect(snapshot!.stateSeq).toBe(0n);
    applyLog(reloaded, snapshot!, await repository.loadUpdates(DOC, 0n));
    expect(sameState(encodeState(reloaded), before)).toBe(true);
    doc.destroy();
    reloaded.destroy();
  });
});

describe('the repository refuses what the database refuses', () => {
  it('will not append an empty update', async () => {
    const repository = new MemoryDocumentRepository();
    repository.create(DOC);
    await expect(repository.appendUpdate(DOC, new Uint8Array(0), null)).rejects.toThrow(/empty/u);
  });

  it('will not move the checkpoint backwards', async () => {
    const repository = new MemoryDocumentRepository();
    repository.create(DOC);
    const doc = new Y.Doc();
    doc.clientID = 1;
    await typeInto(repository, doc, ['one', 'two']);
    await repository.compact({
      documentId: DOC,
      state: encodeState(doc),
      stateSeq: 2n,
      contentText: '',
    });
    await expect(
      repository.compact({
        documentId: DOC,
        state: encodeState(doc),
        stateSeq: 1n,
        contentText: '',
      }),
    ).rejects.toThrow(/backwards/u);
    doc.destroy();
  });

  it('will not accept a checkpoint claiming updates that were never allocated', async () => {
    // Mirrors CHECK (next_seq > state_seq).
    const repository = new MemoryDocumentRepository();
    repository.create(DOC);
    await expect(
      repository.compact({
        documentId: DOC,
        state: emptyDocumentState(),
        stateSeq: 9n,
        contentText: '',
      }),
    ).rejects.toThrow(/un-allocated/u);
  });

  it('allocates a gapless sequence under interleaved appends', async () => {
    const repository = new MemoryDocumentRepository();
    repository.create(DOC);
    const seqs = await Promise.all(
      Array.from({ length: 20 }, () => repository.appendUpdate(DOC, new Uint8Array([0, 0]), null)),
    );
    expect([...seqs].sort((a, b) => Number(a - b))).toEqual(
      Array.from({ length: 20 }, (_, i) => BigInt(i + 1)),
    );
  });
});
