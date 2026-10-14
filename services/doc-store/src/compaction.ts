/**
 * When to compact, and what a compaction consists of.
 *
 * Both halves are pure. The decision takes the counts and a clock; the plan
 * takes a document and the log rows that are in it. Neither touches a database,
 * which is what lets the crash-window argument in docs/SPECS.md section 3.2 be
 * a test rather than a paragraph.
 */
import type * as Y from 'yjs';

import { encodeState, plainTextOf } from './state.js';
import type { CompactionWrite, LoggedUpdate, PendingUpdates } from './ports.js';

export interface CompactionPolicy {
  /** Compact once the log for a document passes this many rows. */
  readonly afterUpdates: number;
  /** ...or once its oldest un-compacted row is this old. */
  readonly afterSeconds: number;
}

export function assertCompactionPolicy(policy: CompactionPolicy): void {
  if (!Number.isInteger(policy.afterUpdates) || policy.afterUpdates < 1) {
    throw new Error('COMPACT_AFTER_UPDATES must be a positive integer.');
  }
  if (!Number.isInteger(policy.afterSeconds) || policy.afterSeconds < 1) {
    throw new Error('COMPACT_AFTER_SECONDS must be a positive integer.');
  }
}

/**
 * Whether this document is due for a checkpoint.
 *
 * Two triggers rather than one, because they cover different documents. The row
 * count catches a document somebody is typing into hard; the age catches one
 * edited a sentence at a time over an afternoon, which would otherwise never
 * reach the count and would replay its whole log on every load.
 *
 * `now` is a parameter. A default of `Date.now()` would make the age branch
 * testable only by sleeping.
 */
export function shouldCompact(
  pending: PendingUpdates,
  policy: CompactionPolicy,
  now: number,
): boolean {
  if (pending.count === 0) return false;
  if (pending.count >= policy.afterUpdates) return true;
  if (pending.oldestAt === null) return false;
  return now - pending.oldestAt.getTime() >= policy.afterSeconds * 1000;
}

/**
 * What to write, given the document as it stands and the rows that are in it.
 *
 * `stateSeq` is the highest seq among the rows PASSED IN, never the document's
 * highest allocated seq. That distinction is the one that matters: an update may
 * have been appended to the log by the other sync replica between the read and
 * this call, and claiming it was folded in would let the truncation delete a row
 * this checkpoint does not contain. The invariants migration's
 * `CHECK (next_seq > state_seq)` is the backstop; this is the reason it never
 * fires.
 *
 * Returns null when there is nothing to fold in, so a caller cannot write a
 * checkpoint that advances nothing and truncates nothing.
 */
export function planCompaction(
  documentId: string,
  doc: Y.Doc,
  folded: readonly LoggedUpdate[],
): CompactionWrite | null {
  if (folded.length === 0) return null;

  let stateSeq = folded[0]!.seq;
  for (const entry of folded) if (entry.seq > stateSeq) stateSeq = entry.seq;

  return {
    documentId,
    state: encodeState(doc),
    stateSeq,
    contentText: plainTextOf(doc),
  };
}
