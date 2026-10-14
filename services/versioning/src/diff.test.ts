import { DOCUMENT_FRAGMENT, encodeState } from '@docs/doc-store';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { countLines, diffBetween, diffStates, diffText } from './diff.js';

function stateOf(...paragraphs: string[]): Uint8Array {
  const doc = new Y.Doc();
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

describe('diffText', () => {
  it('is empty for two identical documents', () => {
    expect(diffText('one\ntwo', 'one\ntwo')).toEqual([
      { kind: 'unchanged', text: 'one' },
      { kind: 'unchanged', text: 'two' },
    ]);
  });

  it('is nothing at all for two empty documents', () => {
    expect(diffText('', '')).toEqual([]);
  });

  it('reports deleting the last line as one removal, not as a whole-document rewrite', () => {
    // The line-terminator case. jsdiff tokenises a line together with its
    // newline, so without `terminated()` the final line of the old text and the
    // final line of the new text are different tokens and the whole document
    // reads as removed-then-re-added.
    const lines = diffText('one\ntwo\nthree', 'one\ntwo');
    expect(lines).toEqual([
      { kind: 'unchanged', text: 'one' },
      { kind: 'unchanged', text: 'two' },
      { kind: 'removed', text: 'three' },
    ]);
  });

  it('keeps a 200-line document at two changed rows when one line in the middle moves', () => {
    // The property the previous test protects, at the size where it matters.
    const before = Array.from({ length: 200 }, (_unused, index) => `line ${index}`);
    const after = [...before];
    after[100] = 'line one hundred, rewritten';
    const changed = diffText(before.join('\n'), after.join('\n')).filter(
      (line) => line.kind !== 'unchanged',
    );
    expect(changed).toEqual([
      { kind: 'removed', text: 'line 100' },
      { kind: 'added', text: 'line one hundred, rewritten' },
    ]);
  });

  it('marks a replaced line as one removal and one addition', () => {
    expect(diffText('one\ntwo\nthree', 'one\nTWO\nthree')).toEqual([
      { kind: 'unchanged', text: 'one' },
      { kind: 'removed', text: 'two' },
      { kind: 'added', text: 'TWO' },
      { kind: 'unchanged', text: 'three' },
    ]);
  });

  it('splits a multi-line chunk into one entry per line', () => {
    // jsdiff groups consecutive lines of the same kind into a single change
    // whose value still carries the newlines. The renderer wants a row per line.
    const lines = diffText('', 'alpha\nbeta\ngamma');
    expect(lines).toEqual([
      { kind: 'added', text: 'alpha' },
      { kind: 'added', text: 'beta' },
      { kind: 'added', text: 'gamma' },
    ]);
  });

  it('does not invent a blank line at the join between chunks', () => {
    // The trailing empty string after a final newline: 'a\nb\n' is two lines,
    // not three. Keeping it puts a phantom row between every pair of chunks.
    const lines = diffText('a\nb\nc', 'a\nb\nc\nd');
    expect(lines.filter((line) => line.text === '')).toEqual([]);
  });

  it('reports a pure deletion', () => {
    expect(diffText('one\ntwo', 'one')).toEqual([
      { kind: 'unchanged', text: 'one' },
      { kind: 'removed', text: 'two' },
    ]);
  });
});

describe('countLines', () => {
  it('counts each kind separately, which is what the panel header shows', () => {
    const counted = countLines(diffText('a\nb\nc', 'a\nB\nc\nd'));
    expect(counted.addedLines).toBe(2);
    expect(counted.removedLines).toBe(1);
    expect(counted.lines).toHaveLength(5);
  });

  it('copies the array rather than handing back the one it was given', () => {
    const lines = diffText('a', 'b');
    const counted = countLines(lines);
    expect(counted.lines).not.toBe(lines);
    expect(counted.lines).toEqual(lines);
  });
});

describe('diffStates', () => {
  it('diffs two encoded documents at the line level', () => {
    const before = stateOf('the append path', 'the compaction path');
    const after = stateOf('the append path', 'the replay path', 'the compaction path');
    const counted = diffStates(before, after);
    expect(counted.lines).toEqual([
      { kind: 'unchanged', text: 'the append path' },
      { kind: 'added', text: 'the replay path' },
      { kind: 'unchanged', text: 'the compaction path' },
    ]);
    expect(counted.addedLines).toBe(1);
    expect(counted.removedLines).toBe(0);
  });

  it('sees no change between two encodings of the same document', () => {
    // The update format is not canonical -- two encodings of one document differ
    // byte for byte -- so this is the property that keeps a version panel from
    // reporting an edit nobody made.
    expect(diffStates(stateOf('unchanged'), stateOf('unchanged')).lines).toEqual([
      { kind: 'unchanged', text: 'unchanged' },
    ]);
  });

  it('reports an empty document restored over a full one as pure removal', () => {
    const counted = diffStates(stateOf('gone', 'also gone'), stateOf());
    expect(counted.removedLines).toBe(2);
    expect(counted.addedLines).toBe(0);
  });
});

describe('diffBetween', () => {
  it('is the wire shape, with null meaning the live document', () => {
    const diff = diffBetween(3, null, stateOf('before'), stateOf('after'));
    expect(diff.from).toBe(3);
    expect(diff.to).toBeNull();
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(1);
  });

  it('carries both version numbers when comparing two versions', () => {
    const diff = diffBetween(3, 7, stateOf('a'), stateOf('a'));
    expect(diff.from).toBe(3);
    expect(diff.to).toBe(7);
    expect(diff.addedLines).toBe(0);
  });
});
