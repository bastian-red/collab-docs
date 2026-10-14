/**
 * Turning a Y.Doc into bytes and back, in one place.
 *
 * Every other module here takes or returns a `Y.Doc`; this is the only file that
 * knows how one is encoded. `Uint8Array` throughout, never `Buffer`: `Buffer`
 * semantics would leak into a service that has to run in a browser bundle too,
 * and a `Buffer` that shares an underlying `ArrayBuffer` with a larger
 * allocation quietly changes what `byteLength` means. The conversion happens
 * once, in packages/db's Prisma adapter, and nowhere else.
 */
import { EMPTY_DOCUMENT_STATE } from '@docs/shared';
import * as Y from 'yjs';

/**
 * The fragment TipTap binds to. Named here rather than passed around, because
 * three processes have to agree on it and a mismatch is silently successful: the
 * editor renders an empty document beside a database row full of text.
 */
export const DOCUMENT_FRAGMENT = 'default';

/**
 * The encoded state of a brand-new document.
 *
 * A fresh document gets this rather than null, so no read path has to branch on
 * "has this ever been saved".
 *
 * Computed here, but also written down as a literal in
 * `@docs/shared`'s EMPTY_DOCUMENT_STATE, because `apps/api` creates document
 * rows and cannot import this package (CommonJS, and the Yjs stack is ESM-only
 * in its types). `state.test.ts` asserts the two agree, so the literal cannot
 * quietly stop being right.
 */
export function emptyDocumentState(): Uint8Array {
  const doc = new Y.Doc();
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** What `@docs/shared` claims an empty document encodes to. Re-exported so the
 * assertion in `state.test.ts` reads in one place. */
export const SHARED_EMPTY_DOCUMENT_STATE = EMPTY_DOCUMENT_STATE;

/** The whole document as one update, which is what a checkpoint and a version are. */
export function encodeState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/**
 * A detached Y.Doc carrying exactly this state.
 *
 * Used for a version restore and for a diff. The caller owns it and must
 * `destroy()` it: a Y.Doc registers observers on its own internal structures,
 * and one materialised per request and never destroyed is a slow leak that shows
 * up as a sync server that needs restarting every few days.
 */
export function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

/**
 * The plain-text projection, for the full-text index and for a text diff.
 *
 * Lossy on purpose and never read back as the document. Block-level elements
 * become lines so a diff is line-oriented, which is the granularity a person
 * reads; a character diff of reflowed prose is noise.
 */
export function plainTextOf(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
  const lines: string[] = [];
  collect(fragment.toArray(), lines);
  // A Y.XmlText can itself hold newlines (a code block is one text node), so a
  // run of blank lines can still arrive from inside a single node. Collapse it
  // here rather than in the walker, which only ever sees one node at a time.
  return lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

type XmlChild = Y.XmlElement | Y.XmlFragment | Y.XmlText | Y.XmlHook;

const BLOCK_TAGS = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'horizontalRule',
]);

function collect(children: XmlChild[], lines: string[]): void {
  for (const child of children) {
    if (child instanceof Y.XmlText) {
      appendInline(lines, child.toString());
      continue;
    }
    if (child instanceof Y.XmlElement || child instanceof Y.XmlFragment) {
      const isBlock = child instanceof Y.XmlElement && BLOCK_TAGS.has(child.nodeName);
      if (isBlock) startLine(lines);
      collect(child.toArray() as XmlChild[], lines);
      if (isBlock) startLine(lines);
    }
  }
}

/**
 * Open a new line, but only when the current one has something on it.
 *
 * Two adjacent paragraphs are two lines, not two lines with a blank between
 * them, and a listItem wrapping a paragraph is one line, not three. Pushing an
 * unconditional separator on both sides of every block is what produced the
 * blank line: nesting doubles it, and a blank line the author never typed shows
 * up as an inserted line in every version diff that touches a block boundary,
 * and as an extra lexeme position in the search vector.
 */
function startLine(lines: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
}

function appendInline(lines: string[], text: string): void {
  // Y.XmlText.toString() returns the text with any inline formatting rendered as
  // tags. The projection wants the words, so the tags come out here rather than
  // in the caller, where every caller would have to remember.
  const stripped = text.replace(/<[^>]*>/gu, '');
  if (stripped.length === 0) return;
  // Always fill the line startLine() opened. Pushing instead would leave that
  // empty entry behind and put the blank line straight back.
  if (lines.length === 0) lines.push(stripped);
  else lines[lines.length - 1] = `${lines[lines.length - 1]!}${stripped}`;
}
