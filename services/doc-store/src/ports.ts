/**
 * What this service needs from a database, and nothing more.
 *
 * It talks to Postgres through this interface rather than through Prisma
 * directly, because the interesting part -- the replay order, the compaction
 * boundary, the crash windows -- can then be tested exhaustively against an
 * in-memory implementation in the free lane. A test that needs a live Postgres
 * is a test that runs in a lane costing ninety seconds, which is a test that
 * does not run.
 *
 * The port is deliberately thin and boring. It exposes rows and two atomic
 * primitives (`appendUpdate`, `compact`) and no behaviour: there is no
 * `appendAndMaybeCompact`, because then the decision under test would live in
 * the adapter and the in-memory twin would be a second implementation of it
 * rather than a fake.
 */

/** The checkpoint row: `documents.state` plus the two counters around it. */
export interface DocumentSnapshot {
  /**
   * `Y.encodeStateAsUpdate` of the document as of `stateSeq`. Never zero bytes:
   * an empty Y.Doc still encodes to two, and `CHECK (octet_length(state) > 0)`
   * says so in the database.
   */
  readonly state: Uint8Array;
  /** The highest `seq` folded into `state`. 0 means nothing has been folded in. */
  readonly stateSeq: bigint;
  /** The next `seq` the allocator will hand out. Always `> stateSeq`. */
  readonly nextSeq: bigint;
}

/** One row of the append-only log. */
export interface LoggedUpdate {
  readonly seq: bigint;
  readonly update: Uint8Array;
}

/** What the cadence decision needs to know, and only that. */
export interface PendingUpdates {
  readonly count: number;
  /** When the oldest un-compacted update arrived, or null when there are none. */
  readonly oldestAt: Date | null;
}

export interface CompactionWrite {
  readonly documentId: string;
  readonly state: Uint8Array;
  readonly stateSeq: bigint;
  /** The plain-text projection, for the full-text index. Lossy, and only for search. */
  readonly contentText: string;
}

export interface DocumentRepository {
  /** The checkpoint, or null when no such document exists. */
  loadSnapshot(documentId: string): Promise<DocumentSnapshot | null>;

  /**
   * Every update with `seq > afterSeq`, ascending.
   *
   * Ascending is not cosmetic. Yjs updates commute, so a shuffled replay reaches
   * the same document -- but `seq` order is what makes a partial replay
   * meaningful, and it is what lets a reader of the log reconstruct history.
   */
  loadUpdates(documentId: string, afterSeq: bigint): Promise<LoggedUpdate[]>;

  /**
   * Allocate a `seq` and insert the update, in ONE transaction.
   *
   * The allocation is `UPDATE documents SET next_seq = next_seq + 1 RETURNING
   * next_seq`, which takes a row lock, so two sync replicas appending at the
   * same instant queue rather than race. In one transaction with the insert, so
   * a crash between them rolls the number back instead of burning it and leaving
   * a gap that a later replay would read as corruption.
   */
  appendUpdate(documentId: string, update: Uint8Array, authorId: string | null): Promise<bigint>;

  pendingUpdates(documentId: string): Promise<PendingUpdates>;

  /**
   * Write the checkpoint and delete every logged update at or below `stateSeq`,
   * in ONE transaction.
   *
   * A crash between the two halves is safe and that is the whole design -- see
   * docs/SPECS.md section 3.2 -- but it must not be possible to delete rows
   * without having written the checkpoint that supersedes them.
   */
  compact(write: CompactionWrite): Promise<void>;
}
