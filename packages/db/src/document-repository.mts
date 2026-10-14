/**
 * The Prisma adapter for `@docs/doc-store`'s `DocumentRepository` port.
 *
 * **This file is `.mts`, and that is the architecture, not a preference.**
 *
 * `packages/db` is CommonJS, because `apps/api` is NestJS and NestJS is
 * CommonJS. The Yjs stack -- `yjs`, `y-protocols`, `@hocuspocus/server` -- ships
 * ESM-only type declarations, so a CommonJS file that imports any of them fails
 * to typecheck with TS1479 even though all five packages load fine at runtime.
 * One file in this package needs those types, so one file is ESM and its
 * extension says so.
 *
 * The consequence is the useful part. `package.json` publishes this as
 * `@docs/db/documents` with an `import` condition and **no `require`
 * condition**, so `apps/api` cannot reach it even by accident. docs/SPECS.md
 * section 2.2 says "the document text is written only by `apps/sync`"; this is
 * what makes that a compile error rather than a convention. `export-map.test.ts`
 * pins it.
 *
 * It is also the only place in the repository where `Uint8Array` becomes
 * `Buffer`. Everything above it speaks `Uint8Array`, because `Buffer` semantics
 * would leak into a service that has to run in a browser bundle too.
 */
import type {
  CompactionWrite,
  DocumentRepository,
  DocumentSnapshot,
  LoggedUpdate,
  PendingUpdates,
} from '@docs/doc-store';

// Type-only, so this file emits no runtime import at all: the adapter needs the
// client's SHAPE, never its constructor. Which also sidesteps the named-export
// interop question entirely -- Prisma's generated client is CommonJS built by
// assignment, and `import { PrismaClient }` from an ES module depends on
// cjs-module-lexer being able to see through that.
import type { PrismaClient } from '../generated/client/index.js';

/**
 * Prisma hands back a `Buffer`, which IS a `Uint8Array` -- and is also a view
 * into a shared allocation pool. Passing one upward would make `byteLength`
 * mean "this slice" while `buffer.byteLength` means "the pool", and a caller
 * that reached for the underlying `ArrayBuffer` would read somebody else's
 * bytes. The copy is one allocation per load and removes the whole class.
 */
function toBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

/** The mirror image, at the same boundary. */
function toBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * A soft-deleted document loads as "no such document".
   *
   * The alternative -- loading it and refusing the writes -- would put the text
   * of a deleted document on the wire to anyone who kept the URL, and would let
   * a reconnecting client resurrect it by syncing its offline copy back.
   */
  async loadSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
    const row = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { state: true, stateSeq: true, nextSeq: true },
    });
    if (row === null) return null;
    return { state: toBytes(row.state), stateSeq: row.stateSeq, nextSeq: row.nextSeq };
  }

  async loadUpdates(documentId: string, afterSeq: bigint): Promise<LoggedUpdate[]> {
    const rows = await this.prisma.documentUpdate.findMany({
      where: { documentId, seq: { gt: afterSeq } },
      // The port promises ascending, `applyLog` sorts anyway, and both are
      // cheap. Two guarantees rather than one, because the cost of the second is
      // an index scan direction and the cost of neither is a compaction that
      // truncates rows it never folded in.
      orderBy: { seq: 'asc' },
      select: { seq: true, update: true },
    });
    return rows.map((row) => ({ seq: row.seq, update: toBytes(row.update) }));
  }

  /**
   * Allocate a `seq` and insert the update, in one transaction.
   *
   * `UPDATE ... SET next_seq = next_seq + 1 RETURNING next_seq - 1` takes a row
   * lock on the document for the rest of the transaction, so two sync replicas
   * appending at the same instant queue instead of racing, and the numbers come
   * out dense and gapless. `RETURNING next_seq - 1` rather than `next_seq`:
   * the column names the NEXT number, so the one just allocated is one below the
   * value the UPDATE leaves behind.
   *
   * A `SELECT ... FOR UPDATE` followed by an `UPDATE` would be two statements
   * and the same lock; this is one round trip. `nextval()` on a sequence would
   * be faster and wrong: sequences are not transactional, so a rolled-back
   * append would burn a number and leave a gap that a later replay reads as a
   * missing update.
   *
   * The zero-row case is a document that does not exist (or was hard-deleted
   * between the handshake and this write). Throwing beats inserting an orphan
   * row that no load path would ever read.
   */
  async appendUpdate(documentId: string, update: Uint8Array, authorId: string | null): Promise<bigint> {
    return this.prisma.$transaction(async (tx) => {
      const allocated = await tx.$queryRaw<Array<{ seq: bigint }>>`
        UPDATE "documents"
           SET "next_seq" = "next_seq" + 1
         WHERE "id" = ${documentId}
           AND "deleted_at" IS NULL
        RETURNING "next_seq" - 1 AS "seq"
      `;
      const seq = allocated[0]?.seq;
      if (seq === undefined) {
        throw new Error(`Cannot append to document ${documentId}: it does not exist or was deleted.`);
      }

      await tx.documentUpdate.create({
        data: { documentId, seq, update: toBuffer(update), authorId },
      });

      return seq;
    });
  }

  async pendingUpdates(documentId: string): Promise<PendingUpdates> {
    const result = await this.prisma.documentUpdate.aggregate({
      where: { documentId },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    return { count: result._count._all, oldestAt: result._min.createdAt };
  }

  /**
   * Write the checkpoint and truncate what it folded in, in one transaction.
   *
   * The order inside the transaction does not matter -- it commits or it does
   * not -- but the order of the two ACROSS transactions would matter very much,
   * which is why they are not two transactions. Truncating first and crashing
   * before the checkpoint would delete updates nothing has folded in: the only
   * unrecoverable failure in the whole design. See docs/SPECS.md section 3.2.
   *
   * `updatedAt` is left to Prisma's `@updatedAt`. A compaction is a write, and a
   * document list ordered by `updated_at` that ignores it would reorder itself
   * every time a checkpoint happened to run.
   */
  async compact(write: CompactionWrite): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.document.update({
        where: { id: write.documentId },
        data: {
          state: toBuffer(write.state),
          stateSeq: write.stateSeq,
          contentText: write.contentText,
        },
      }),
      this.prisma.documentUpdate.deleteMany({
        where: { documentId: write.documentId, seq: { lte: write.stateSeq } },
      }),
    ]);
  }
}
