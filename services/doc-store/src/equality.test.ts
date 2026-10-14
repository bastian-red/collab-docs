import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentFingerprint, sameDocument, sameState } from './equality.js';

/**
 * A test-equality helper that is wrong is worse than none: every test built on
 * it becomes a test of the helper's bug. So it gets its own tests, and they
 * include the two cases the obvious implementations get wrong.
 */

function docWith(build: (doc: Y.Doc) => void): Y.Doc {
  const doc = new Y.Doc();
  build(doc);
  return doc;
}

describe('sameDocument', () => {
  it('is true for a document and a copy synced from it', () => {
    const a = docWith((d) => d.getText('t').insert(0, 'hello world'));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(sameDocument(a, b)).toBe(true);
    a.destroy();
    b.destroy();
  });

  it('is false when one document has an extra insertion', () => {
    const a = docWith((d) => d.getText('t').insert(0, 'hello'));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getText('t').insert(0, 'X');
    expect(sameDocument(a, b)).toBe(false);
    a.destroy();
    b.destroy();
  });

  it('is false when the ONLY difference is a deletion', () => {
    // The case a state-vector comparison gets wrong, and it gets it wrong in the
    // direction that hides a bug: it calls these two equal.
    const a = docWith((d) => d.getText('t').insert(0, 'hello world'));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getText('t').delete(0, 6);

    expect(Buffer.from(Y.encodeStateVector(a)).equals(Buffer.from(Y.encodeStateVector(b)))).toBe(
      true,
    );
    expect(sameDocument(a, b)).toBe(false);
    a.destroy();
    b.destroy();
  });

  it('is true for two documents that reached the same place by different routes', () => {
    // Concurrent inserts integrated in opposite orders. Their encoded bytes
    // differ; the documents do not.
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText('t').insert(0, 'AAA');
    b.getText('t').insert(0, 'BBB');
    const fromA = Y.encodeStateAsUpdate(a);
    const fromB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, fromB);
    Y.applyUpdate(b, fromA);

    expect(sameDocument(a, b)).toBe(true);
    expect(a.getText('t').toString()).toBe(b.getText('t').toString());
    a.destroy();
    b.destroy();
  });

  it('survives a document with deletions, where the naive diff is never empty', () => {
    // The measured failure that produced this module.
    const a = docWith((d) => {
      const t = d.getText('t');
      t.insert(0, 'the nightly batch reconciliation');
      t.delete(0, 4);
      t.delete(3, 6);
    });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const naiveDiff = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    expect(naiveDiff.byteLength).toBeGreaterThan(2);
    expect(sameDocument(a, b)).toBe(true);
    a.destroy();
    b.destroy();
  });
});

describe('sameState', () => {
  it('compares encoded states rather than their bytes', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText('t').insert(0, 'AAA');
    b.getText('t').insert(0, 'BBB');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    expect(sameState(Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b))).toBe(true);
    a.destroy();
    b.destroy();
  });

  it('says no when they really differ', () => {
    const a = docWith((d) => d.getText('t').insert(0, 'one'));
    const b = docWith((d) => d.getText('t').insert(0, 'two'));
    expect(sameState(Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b))).toBe(false);
    a.destroy();
    b.destroy();
  });
});

describe('documentFingerprint', () => {
  it('is stable across repeated calls', () => {
    const a = docWith((d) => d.getText('t').insert(0, 'hello'));
    expect(documentFingerprint(a)).toBe(documentFingerprint(a));
    a.destroy();
  });
});
