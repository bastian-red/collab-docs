/**
 * The in-memory twin of the Prisma adapter.
 *
 * It exists so the replay, compaction and crash-window tests run in the free
 * lane. It is a FAKE, not a mock: it stores rows and answers queries, and it
 * implements the two atomicity promises the port makes -- an append allocates
 * and inserts together, a compaction writes and truncates together -- because
 * those promises are exactly what the tests are checking the callers rely on
 * correctly.
 *
 * It also deliberately implements the two failure modes the design has to
 * survive, so they can be provoked without a `kill -9`: see `failAfterWrite`.
 */
import type {
  CompactionWrite,
  DocumentRepository,
  DocumentSnapshot,
  LoggedUpdate,
  PendingUpdates,
} from './ports.js';
import { emptyDocumentState } from './state.js';

interface Row {
  state: Uint8Array;
  stateSeq: bigint;
  nextSeq: bigint;
  contentText: string;
  updates: Array<{ seq: bigint; update: Uint8Array; authorId: string | null; at: Date }>;
}

export class CompactionInterrupted extends Error {
  constructor() {
    super('Simulated crash between the checkpoint write and the log truncation.');
    this.name = 'CompactionInterrupted';
  }
}

export class MemoryDocumentRepository implements DocumentRepository {
  private readonly rows = new Map<string, Row>();

  /**
   * When set, the next `compact` writes the checkpoint and then throws INSTEAD
   * of truncating the log.
   *
   * This is the exact crash window the whole design turns on: the checkpoint is
   * durable, the rows it superseded are still there, and the next load replays
   * updates that are already inside the checkpoint. Being able to provoke it
   * deterministically is what makes that a test rather than an argument.
   */
  failAfterWrite = false;

  constructor(private readonly now: () => number = Date.now) {}

  create(documentId: string, state: Uint8Array = emptyDocumentState()): void {
    this.rows.set(documentId, {
      state,
      stateSeq: 0n,
      nextSeq: 1n,
      contentText: '',
      updates: [],
    });
  }

  async loadSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
    const row = this.rows.get(documentId);
    if (row === undefined) return null;
    return { state: row.state, stateSeq: row.stateSeq, nextSeq: row.nextSeq };
  }

  async loadUpdates(documentId: string, afterSeq: bigint): Promise<LoggedUpdate[]> {
    const row = this.require(documentId);
    return row.updates
      .filter((entry) => entry.seq > afterSeq)
      .sort((a, b) => (a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1))
      .map((entry) => ({ seq: entry.seq, update: entry.update }));
  }

  async appendUpdate(
    documentId: string,
    update: Uint8Array,
    authorId: string | null,
  ): Promise<bigint> {
    if (update.byteLength === 0) {
      // Mirrors CHECK (octet_length("update") > 0). An empty update is a bug in
      // the append path that would replay as a no-op forever and be invisible.
      throw new Error('Refusing to append an empty update.');
    }
    const row = this.require(documentId);
    const seq = row.nextSeq;
    row.nextSeq += 1n;
    row.updates.push({ seq, update, authorId, at: new Date(this.now()) });
    return seq;
  }

  async pendingUpdates(documentId: string): Promise<PendingUpdates> {
    const row = this.require(documentId);
    const pending = row.updates.filter((entry) => entry.seq > row.stateSeq);
    if (pending.length === 0) return { count: 0, oldestAt: null };
    let oldest = pending[0]!.at;
    for (const entry of pending) if (entry.at < oldest) oldest = entry.at;
    return { count: pending.length, oldestAt: oldest };
  }

  async compact(write: CompactionWrite): Promise<void> {
    const row = this.require(write.documentId);

    if (write.stateSeq < row.stateSeq) {
      // Mirrors nothing in the database, because the database cannot see it: a
      // checkpoint that moves BACKWARDS would un-fold updates and the next load
      // would still be correct (they are in the log) but the invariant
      // "state_seq only rises" would be gone, and with it every argument that
      // depends on it.
      throw new Error('Refusing to move the checkpoint backwards.');
    }
    if (write.stateSeq >= row.nextSeq) {
      // Mirrors CHECK (next_seq > state_seq).
      throw new Error('Refusing a checkpoint that claims un-allocated updates.');
    }

    row.state = write.state;
    row.stateSeq = write.stateSeq;
    row.contentText = write.contentText;

    if (this.failAfterWrite) {
      this.failAfterWrite = false;
      throw new CompactionInterrupted();
    }

    row.updates = row.updates.filter((entry) => entry.seq > write.stateSeq);
  }

  // --- test affordances, not part of the port -------------------------------

  logSize(documentId: string): number {
    return this.require(documentId).updates.length;
  }

  contentText(documentId: string): string {
    return this.require(documentId).contentText;
  }

  allSeqs(documentId: string): bigint[] {
    return this.require(documentId).updates.map((entry) => entry.seq);
  }

  private require(documentId: string): Row {
    const row = this.rows.get(documentId);
    if (row === undefined) throw new Error(`No such document: ${documentId}`);
    return row;
  }
}
