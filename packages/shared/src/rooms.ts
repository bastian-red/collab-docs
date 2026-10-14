/**
 * The strings more than one process has to agree on.
 *
 * A drifted room name is silently successful: the web app connects, the sync
 * server refuses or opens a different room, and the update never arrives at the
 * other person's screen. That looks like a CRDT bug and is not one, so the name is
 * computed here and nowhere else.
 *
 * **The Hocuspocus document name IS the document id**, with no prefix.
 * `apps/sync/src/auth.ts` `documentIdFromRoom` parses it with `idSchema` and uses
 * it as the database key, because that is the point where an arbitrary
 * client-supplied string becomes a key and the strictest parser should guard it.
 * An earlier version of this file, ported from a socket.io project, prefixed
 * `doc:`; nothing on the server used it, and a client built on it would have been
 * refused on every document. `apps/sync/src/auth.test.ts` now round-trips this
 * function through the server's parser, so the two cannot drift apart again.
 */
export function documentRoom(documentId: string): string {
  return documentId;
}

/**
 * The IndexedDB database a browser keeps a document's offline copy in.
 *
 * Namespaced by app, because IndexedDB is per origin and `localhost:3000` is
 * shared by every project a developer runs on that port: a bare id would collide
 * with any other app that also names its stores by id.
 */
export function offlineStoreName(documentId: string): string {
  return `collab-docs:${documentId}`;
}

/** The Redis pub/sub channel the sync server's health probe round-trips on. */
export const HEALTH_PROBE_CHANNEL = 'collab:health:probe';
