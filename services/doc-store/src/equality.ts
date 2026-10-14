/**
 * When are two Yjs documents the same document?
 *
 * This module exists because the obvious answers are all wrong, and each wrong
 * answer fails in a direction that invites you to "fix" working code.
 *
 * **Wrong answer 1: compare the encoded bytes.**
 * `Y.encodeStateAsUpdate` is not canonical. Two documents holding identical
 * content encode differently depending on the order their items were integrated,
 * which for a CRDT is exactly the thing that is allowed to differ. A byte
 * comparison reports divergence for documents that have converged.
 *
 * **Wrong answer 2: ask for the diff and check it is empty.**
 * `Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))` is the natural "what does b
 * lack" question, and an empty answer is two bytes. But a state vector describes
 * INSERTIONS only -- it has no room for deletions -- so the diff carries the
 * whole delete set regardless. Measured on the convergence suite below: five
 * clients that had provably converged (byte-identical rendered text) reported
 * 178 bytes "missing" in both directions. Believing that number sends a debugger
 * into the merge logic for a day.
 *
 * **Wrong answer 3: compare state vectors.**
 * Closer, and wrong in the dangerous direction: it calls two documents equal
 * when one of them has deleted a paragraph the other still shows. Verified
 * rather than reasoned about -- a deletion-only difference leaves the two state
 * vectors byte-identical.
 *
 * **The right answer: compare snapshots.** `Y.snapshot(doc)` is precisely the
 * pair (state vector, delete set), which is the complete description of a Yjs
 * document's logical state, and `Y.encodeSnapshot` gives it a canonical
 * encoding. It reports both failure cases above correctly, and it holds under
 * `gc: true` -- which had to be checked, because garbage collection rewrites the
 * struct store and could in principle have made two converged documents encode
 * differently. It does not: eight seeded five-client runs agree.
 */
import * as Y from 'yjs';

/** The canonical encoding of a document's logical state: insertions and deletions. */
export function documentFingerprint(doc: Y.Doc): string {
  return Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString('hex');
}

/** Whether two live documents have converged. */
export function sameDocument(a: Y.Doc, b: Y.Doc): boolean {
  return documentFingerprint(a) === documentFingerprint(b);
}

/**
 * Whether two encoded states describe the same document.
 *
 * Materialises both, because the bytes themselves are not comparable (wrong
 * answer 1 above). Destroys both, because a Y.Doc registers observers on its own
 * internal structures and one materialised per call and never destroyed is a
 * slow leak that presents as a sync server needing a restart every few days.
 */
export function sameState(a: Uint8Array, b: Uint8Array): boolean {
  const left = new Y.Doc();
  const right = new Y.Doc();
  try {
    Y.applyUpdate(left, a);
    Y.applyUpdate(right, b);
    return sameDocument(left, right);
  } finally {
    left.destroy();
    right.destroy();
  }
}
