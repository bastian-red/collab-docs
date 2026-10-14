/**
 * The encoded state of an empty document, as a literal.
 *
 * `apps/api` creates document rows and therefore needs this value, but it is a
 * CommonJS package and cannot import `@docs/doc-store`, which is ESM because the
 * Yjs stack ships ESM-only types. Rather than weaken that boundary, the two
 * bytes live here, where both module systems can reach them.
 *
 * A hardcoded constant is only safe if something proves it is the right
 * constant, so `services/doc-store` has a test that computes
 * `Y.encodeStateAsUpdate(new Y.Doc())` and asserts it equals this array. If a
 * future Yjs changes the encoding of an empty document, that test fails and
 * names this file, instead of the API silently writing rows that
 * `CHECK (octet_length(state) > 0)` accepts and the sync server cannot load.
 */
export const EMPTY_DOCUMENT_STATE: readonly number[] = [0, 0];

/** A fresh copy, because a Uint8Array handed to a caller is mutable. */
export function emptyDocumentStateBytes(): Uint8Array {
  return Uint8Array.from(EMPTY_DOCUMENT_STATE);
}
