/**
 * The text-level diff between two document states.
 *
 * Text-level and not character-attributed, because this project runs Yjs with
 * garbage collection ON: the items a character diff would need were collected
 * the moment they were deleted. That is a deliberate trade (docs/SPECS.md 5.3) --
 * bounded storage in exchange for "what changed" without "who changed it" -- and
 * the UI says so rather than implying otherwise.
 *
 * Line-oriented rather than character-oriented on top of that. A character diff
 * of reflowed prose marks up an entire paragraph because one word moved across a
 * wrap, which is noise dressed as precision.
 *
 * `diff` (jsdiff) does the Myers work. It is the tried-and-true option -- the
 * package every JS diff view is built on, still maintained -- and a hand-rolled
 * LCS here would be a second implementation of a solved problem with its own
 * quadratic blow-up on the pathological input.
 */
import { docFromState, plainTextOf } from '@docs/doc-store';
import type { Diff, DiffLine } from '@docs/shared';
import { diffLines } from 'diff';

/**
 * Split a jsdiff chunk into one entry per line.
 *
 * jsdiff groups consecutive lines of the same kind into a single change whose
 * `value` still carries the newlines. The renderer wants a row per line, so the
 * split happens here rather than in three components.
 *
 * The trailing empty string after a final newline is dropped: `'a\nb\n'` is two
 * lines, not three. Keeping it would put a phantom blank row at the join between
 * every pair of chunks.
 */
function toLines(value: string, kind: DiffLine['kind']): DiffLine[] {
  const parts = value.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((text) => ({ kind, text }));
}

/**
 * Give the text a trailing newline, so every line has a terminator.
 *
 * Not cosmetic. `plainTextOf` returns text with no trailing newline, and jsdiff
 * tokenises by line **including** the terminator, so a final line without one is
 * a different token from the same line with one. Measured, on `diff@9.0.0`:
 *
 * ```
 * diffLines('one\ntwo', 'one')
 *   -> [ {removed: true, value: 'one\ntwo'}, {added: true, value: 'one'} ]
 * diffLines('one\ntwo\n', 'one\n')
 *   -> [ {value: 'one\n'}, {removed: true, value: 'two\n'} ]
 * ```
 *
 * Deleting the last line of a document without this reads as "every line
 * removed, every line re-added": a 200-line document rendering 399 changed rows
 * because somebody deleted one sentence at the end.
 *
 * The empty document stays empty rather than becoming a single blank line, which
 * is why this is not an unconditional concatenation.
 */
function terminated(text: string): string {
  return text === '' ? '' : `${text}\n`;
}

/** The diff of two already-projected plain texts. */
export function diffText(before: string, after: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const change of diffLines(terminated(before), terminated(after))) {
    const kind: DiffLine['kind'] = change.added
      ? 'added'
      : change.removed
        ? 'removed'
        : 'unchanged';
    lines.push(...toLines(change.value, kind));
  }
  return lines;
}

export interface DiffCounts {
  readonly lines: DiffLine[];
  readonly addedLines: number;
  readonly removedLines: number;
}

export function countLines(lines: readonly DiffLine[]): DiffCounts {
  return {
    lines: [...lines],
    addedLines: lines.filter((line) => line.kind === 'added').length,
    removedLines: lines.filter((line) => line.kind === 'removed').length,
  };
}

/**
 * The diff between two encoded states.
 *
 * Both documents are materialised and both are destroyed, in a `finally`. A
 * `Y.Doc` registers observers on its own internal structures; one materialised
 * per request and never destroyed is the slow leak that shows up months later as
 * a sync server needing a restart every few days.
 */
export function diffStates(before: Uint8Array, after: Uint8Array): DiffCounts {
  const beforeDoc = docFromState(before);
  try {
    const afterDoc = docFromState(after);
    try {
      return countLines(diffText(plainTextOf(beforeDoc), plainTextOf(afterDoc)));
    } finally {
      afterDoc.destroy();
    }
  } finally {
    beforeDoc.destroy();
  }
}

/** The wire shape, so `apps/sync`'s diff endpoint has nothing left to assemble. */
export function diffBetween(
  from: number,
  to: number | null,
  before: Uint8Array,
  after: Uint8Array,
): Diff {
  const counted = diffStates(before, after);
  return {
    from,
    to,
    lines: counted.lines,
    addedLines: counted.addedLines,
    removedLines: counted.removedLines,
  };
}
