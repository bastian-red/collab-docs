/**
 * Loading a document: the checkpoint, then the log.
 *
 * The entire persistence design rests on one property of Yjs, and it is worth
 * stating precisely because everything else here is a consequence of it:
 *
 *   **Applying an update is idempotent and commutative.**
 *
 * An update names the client ids and clocks of the items it inserts. Applying it
 * twice inserts nothing the second time, because those items are already
 * present. Applying two updates in either order reaches the same state, because
 * the merge is a function of the items and not of when they arrived.
 *
 * That is why a crash during compaction cannot produce a wrong document. If the
 * process dies after the checkpoint was written but before the log was
 * truncated, this function replays rows that are already folded into the
 * checkpoint, and the result is byte-identical to the one where the truncation
 * succeeded. See docs/SPECS.md section 3.2 for the full table of windows.
 *
 * `replay.test.ts` asserts the property directly rather than trusting this
 * comment.
 */
import * as Y from 'yjs';

import type { DocumentRepository, DocumentSnapshot, LoggedUpdate } from './ports.js';

export interface LoadedDocument {
  /** The highest `seq` now applied, which is where a later compaction starts. */
  readonly appliedSeq: bigint;
  /** How many log rows were replayed, for the log line and for the health page. */
  readonly replayed: number;
}

/**
 * Apply a checkpoint and a log into an existing document.
 *
 * Takes the doc rather than returning one, because Hocuspocus owns the `Y.Doc`
 * -- it hands one to `onLoadDocument` already wired to its connections -- and a
 * function that returned a fresh doc would force the caller to copy state
 * between two of them for no reason.
 *
 * Everything is applied inside ONE `Y.transact`, with a `'load'` origin. Two
 * reasons, both load-bearing:
 *
 *   - One transaction means one `update` event rather than one per row. Without
 *     it, hydrating a document with 200 pending updates fires the append
 *     listener 200 times and writes all 200 straight back to the log.
 *   - A named origin lets the append listener tell "this came from a client"
 *     from "this is the document being loaded", which is the same discrimination
 *     the Redis relay needs.
 */
export const LOAD_ORIGIN = 'doc-store:load';

export function applyLog(
  doc: Y.Doc,
  snapshot: DocumentSnapshot,
  updates: readonly LoggedUpdate[],
): LoadedDocument {
  let appliedSeq = snapshot.stateSeq;

  Y.transact(
    doc,
    () => {
      Y.applyUpdate(doc, snapshot.state, LOAD_ORIGIN);
      // Sorted rather than trusted. The repository promises ascending order and
      // the in-memory twin keeps it, but a future adapter that forgets an ORDER
      // BY would produce a document that is CORRECT (updates commute) with an
      // `appliedSeq` that is WRONG, and the next compaction would then truncate
      // rows it had not folded in. Sorting here costs nothing and removes the
      // possibility.
      for (const entry of [...updates].sort(compareSeq)) {
        Y.applyUpdate(doc, entry.update, LOAD_ORIGIN);
        if (entry.seq > appliedSeq) appliedSeq = entry.seq;
      }
    },
    LOAD_ORIGIN,
  );

  return { appliedSeq, replayed: updates.length };
}

function compareSeq(a: LoggedUpdate, b: LoggedUpdate): number {
  if (a.seq === b.seq) return 0;
  return a.seq < b.seq ? -1 : 1;
}

/** Read the checkpoint and its log, then apply both. Null when no such document. */
export async function loadDocument(
  repository: DocumentRepository,
  documentId: string,
  doc: Y.Doc,
): Promise<LoadedDocument | null> {
  const snapshot = await repository.loadSnapshot(documentId);
  if (snapshot === null) return null;

  const updates = await repository.loadUpdates(documentId, snapshot.stateSeq);
  return applyLog(doc, snapshot, updates);
}
