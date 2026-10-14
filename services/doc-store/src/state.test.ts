import { EMPTY_DOCUMENT_STATE } from '@docs/shared';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  DOCUMENT_FRAGMENT,
  docFromState,
  emptyDocumentState,
  encodeState,
  plainTextOf,
} from './state.js';

describe('emptyDocumentState', () => {
  it('is what @docs/shared hardcodes', () => {
    // apps/api is CommonJS and cannot import this package, so it writes the
    // literal from @docs/shared into every new document row. This is the test
    // that keeps the literal honest: if Yjs ever changes the encoding of an
    // empty document, it fails here and names the file to change, rather than
    // the API silently writing rows the sync server cannot load.
    expect([...emptyDocumentState()]).toEqual([...EMPTY_DOCUMENT_STATE]);
  });

  it('is not zero bytes, which the database also refuses', () => {
    // CHECK (octet_length("state") > 0). A zero-length state would pass every
    // type check and fail at the first INSERT.
    expect(emptyDocumentState().byteLength).toBeGreaterThan(0);
  });

  it('round-trips to an empty document', () => {
    const doc = docFromState(emptyDocumentState());
    expect(doc.getXmlFragment(DOCUMENT_FRAGMENT).length).toBe(0);
    expect(plainTextOf(doc)).toBe('');
    doc.destroy();
  });

  it('hands out a fresh array each time, so a caller cannot poison the next one', () => {
    const first = emptyDocumentState();
    first[0] = 99;
    expect(emptyDocumentState()[0]).toBe(0);
  });
});

describe('plainTextOf', () => {
  function withParagraphs(...texts: string[]): Y.Doc {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
    for (const text of texts) {
      const element = new Y.XmlElement('paragraph');
      element.insert(0, [new Y.XmlText(text)]);
      fragment.insert(fragment.length, [element]);
    }
    return doc;
  }

  it('puts each block on its own line, so a diff is line-oriented', () => {
    const doc = withParagraphs('first line', 'second line');
    expect(plainTextOf(doc)).toBe('first line\nsecond line');
    doc.destroy();
  });

  it('strips inline formatting rather than leaking tags into the search index', () => {
    // Y.XmlText.toString() renders inline marks as tags. A search index full of
    // <strong> matches "strong" for every bold word in the corpus.
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
    const element = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'the nightly batch');
    text.format(4, 7, { strong: {} });
    element.insert(0, [text]);
    fragment.insert(0, [element]);

    const projected = plainTextOf(doc);
    expect(projected).toBe('the nightly batch');
    expect(projected).not.toContain('<');
    doc.destroy();
  });

  it('is empty for an empty document rather than a string of newlines', () => {
    const doc = new Y.Doc();
    expect(plainTextOf(doc)).toBe('');
    doc.destroy();
  });

  it('survives a nested structure', () => {
    // Built top-down: a Y.XmlElement that is not yet in a document warns
    // "Invalid access: Add Yjs type to a document before reading data" the
    // moment anything reads its length, so each node joins the tree before it
    // is filled.
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
    const list = new Y.XmlElement('bulletList');
    fragment.insert(0, [list]);
    for (const label of ['one', 'two']) {
      const item = new Y.XmlElement('listItem');
      list.insert(list.length, [item]);
      const paragraph = new Y.XmlElement('paragraph');
      item.insert(0, [paragraph]);
      paragraph.insert(0, [new Y.XmlText(label)]);
    }
    // listItem and paragraph are both block tags, so the naive
    // separator-on-both-sides walk emitted three newlines per item here.
    expect(plainTextOf(doc)).toBe('one\ntwo');
    doc.destroy();
  });

  it('drops a block the author left empty rather than emitting a blank line', () => {
    // An empty paragraph is a place the caret has been, not content. Keeping it
    // would add a line to every diff and an empty lexeme slot to the search
    // vector, for a block that reads as nothing.
    const doc = withParagraphs('above', '', 'below');
    expect(plainTextOf(doc)).toBe('above\nbelow');
    doc.destroy();
  });

  it('collapses a run of blank lines that came from inside one text node', () => {
    // A code block is a single Y.XmlText holding its own newlines, so the walker
    // never sees the blank lines; the join does.
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
    const block = new Y.XmlElement('codeBlock');
    fragment.insert(0, [block]);
    block.insert(0, [new Y.XmlText('const a = 1;\n\n\n\nconst b = 2;')]);
    expect(plainTextOf(doc)).toBe('const a = 1;\n\nconst b = 2;');
    doc.destroy();
  });

  it('keeps the two paragraphs of a document one line apart after a round trip', () => {
    // content_text is written at compaction time from a doc that was rebuilt
    // from bytes, never from the doc the editor typed into, so the projection
    // has to be stable across an encode.
    const doc = withParagraphs('the append path', 'the compaction path');
    const restored = docFromState(encodeState(doc));
    expect(plainTextOf(restored)).toBe(plainTextOf(doc));
    expect(plainTextOf(restored)).toBe('the append path\nthe compaction path');
    doc.destroy();
    restored.destroy();
  });
});

describe('encodeState / docFromState', () => {
  it('round-trips a document', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
    const element = new Y.XmlElement('paragraph');
    element.insert(0, [new Y.XmlText('the reconciliation path')]);
    fragment.insert(0, [element]);

    const restored = docFromState(encodeState(doc));
    expect(plainTextOf(restored)).toBe('the reconciliation path');
    doc.destroy();
    restored.destroy();
  });
});
