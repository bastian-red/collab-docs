/**
 * The version store, and the diff endpoint that lives here rather than in the
 * API.
 *
 * **Why the API does not own this.** Computing a diff means materialising two
 * `Y.Doc`s from stored states, and `apps/api` is CommonJS while the Yjs stack
 * ships ESM-only types (docs/CODESTYLE.md section 9). `@docs/db/documents`
 * publishes no `require` condition for exactly that reason, so "the API never
 * materialises a CRDT" is a resolution error rather than a convention. The
 * endpoint follows the capability: whoever can build a `Y.Doc` owns the diff.
 */
import { VERSION_N_UNIQUE, violatedUniqueIndex, type PrismaClient } from '@docs/db';
import type { DocumentRepository } from '@docs/doc-store';
import { encodeState, loadDocument } from '@docs/doc-store';
import { DomainError, type Diff, type VersionSummary } from '@docs/shared';
import { diffBetween, labelForKind, nextVersionNumber, planPrune } from '@docs/versioning';
import type { LastVersion, VersionPolicy } from '@docs/versioning';
import * as Y from 'yjs';

import type { CreatedVersion, VersionStore } from './persistence.js';

/**
 * Prisma-backed version storage.
 *
 * `lastVersion` returns a FINGERPRINT of the stored state, not a hash of its
 * bytes, which means materialising that version's document. The update format
 * is not canonical -- two encodings of one document differ byte for byte -- so a
 * byte hash would report "changed" for a document nobody touched and cut a
 * version every interval, forever. The cost is one `Y.Doc` per store hook per
 * document, which is bounded by `STORE_DEBOUNCE_MS`.
 */
export class PrismaVersionStore implements VersionStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fingerprint: (state: Uint8Array) => string,
  ) {}

  async lastVersion(documentId: string): Promise<(LastVersion & { n: number }) | null> {
    const row = await this.prisma.documentVersion.findFirst({
      where: { documentId },
      orderBy: { n: 'desc' },
      select: { n: true, createdAt: true, state: true },
    });
    if (row === null) return null;
    return {
      n: row.n,
      createdAt: row.createdAt,
      fingerprint: this.fingerprint(Uint8Array.from(row.state)),
    };
  }

  async createVersion(input: {
    documentId: string;
    n: number;
    state: Uint8Array;
    kind: 'AUTO' | 'MANUAL';
    label: string | null;
    authorId: string | null;
  }): Promise<CreatedVersion> {
    return this.prisma.documentVersion.create({
      data: {
        documentId: input.documentId,
        n: input.n,
        state: Buffer.from(input.state),
        kind: input.kind,
        label: input.label,
        authorId: input.authorId,
      },
      select: { id: true, createdAt: true },
    });
  }

  async listForPrune(
    documentId: string,
  ): Promise<Array<{ id: string; n: number; kind: 'AUTO' | 'MANUAL' }>> {
    return this.prisma.documentVersion.findMany({
      where: { documentId },
      select: { id: true, n: true, kind: true },
      orderBy: { n: 'asc' },
    });
  }

  async deleteVersions(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.documentVersion.deleteMany({ where: { id: { in: [...ids] } } });
  }
}

export interface DiffRequest {
  readonly documentId: string;
  readonly from: number;
  /** Null means "against the live document", which is the checkpoint plus its log. */
  readonly to: number | null;
}

/**
 * The states two version numbers name.
 *
 * `to === null` reads the document's current state through the same repository
 * the sync server loads with, so the diff is against what a reader would see and
 * not against the last checkpoint -- which, on a busy document, is several
 * paragraphs behind.
 */
export interface DiffSources {
  versionState(documentId: string, n: number): Promise<Uint8Array | null>;
  liveState(documentId: string): Promise<Uint8Array | null>;
}

export async function computeDiff(request: DiffRequest, sources: DiffSources): Promise<Diff> {
  if (request.to !== null && request.from === request.to) {
    throw new DomainError('INVALID', 'A version cannot be compared with itself');
  }

  const before = await sources.versionState(request.documentId, request.from);
  if (before === null)
    throw new DomainError('NOT_FOUND', `No version ${request.from} of this document`);

  const after =
    request.to === null
      ? await sources.liveState(request.documentId)
      : await sources.versionState(request.documentId, request.to);
  if (after === null) {
    throw new DomainError(
      'NOT_FOUND',
      request.to === null
        ? 'This document no longer exists'
        : `No version ${request.to} of this document`,
    );
  }

  return diffBetween(request.from, request.to, before, after);
}

/**
 * How many times a manual cut retries on a colliding version number.
 *
 * `nextVersionNumber` reads the highest `n` and adds one, so two people saving a
 * version in the same instant compute the same number and
 * `UNIQUE (document_id, n)` refuses the second. That is the intended design --
 * the alternative is a global sequence, and a user-visible "version 7" that jumps
 * to 9 because somebody saved a different document reads as data loss.
 *
 * Three attempts, because the loser of a race reads the winner's row on the next
 * pass. Needing a fourth would mean three people saved the same document inside
 * one round trip, at which point failing loudly is better than looping.
 */
const VERSION_ATTEMPTS = 3;

export interface ManualVersionInput {
  readonly documentId: string;
  readonly label: string;
  readonly authorId: string;
  readonly authorName: string;
}

export interface ManualVersionDeps {
  readonly versions: VersionStore;
  readonly repository: DocumentRepository;
  readonly policy: VersionPolicy;
}

/**
 * Cut a version by hand.
 *
 * **The state comes from the repository, not from the in-memory document.** That
 * is deliberate and it is the honest answer: a version is something a restore can
 * return to, and a restore reads what was written. Taking the live `Y.Doc`
 * instead would let somebody save a version containing an update that had not
 * reached Postgres, which is a version that does not exist after a crash. The
 * window is microseconds wide -- every update is appended synchronously, with no
 * debounce (docs/SPECS.md 3.1) -- and it is a window this side of it.
 *
 * The document is destroyed in a `finally`. One `Y.Doc` materialised per request
 * and never destroyed is the slow leak that shows up months later as a sync
 * server needing a restart every few days.
 */
export async function cutManualVersion(
  input: ManualVersionInput,
  deps: ManualVersionDeps,
): Promise<VersionSummary> {
  // Normalised before anything is written, so the row holds what the panel will
  // show. Normalising at render time means the database holds one string and the
  // panel shows another, and a search for what is on screen finds nothing.
  const label = labelForKind('MANUAL', input.label);

  const doc = new Y.Doc();
  let state: Uint8Array;
  try {
    const loaded = await loadDocument(deps.repository, input.documentId, doc);
    if (loaded === null) throw new DomainError('NOT_FOUND', 'Document not found');
    state = encodeState(doc);
  } finally {
    doc.destroy();
  }

  for (let attempt = 1; attempt <= VERSION_ATTEMPTS; attempt += 1) {
    const last = await deps.versions.lastVersion(input.documentId);
    const n = nextVersionNumber(last?.n ?? null);

    try {
      const created = await deps.versions.createVersion({
        documentId: input.documentId,
        n,
        state,
        kind: 'MANUAL',
        label,
        authorId: input.authorId,
      });

      // Pruning never drops a labelled version, so a document with more manual
      // versions than the cap stays over it. That is accepted and explained in
      // `planPrune`: deleting the thing somebody deliberately named is the one
      // behaviour nobody forgives.
      const existing = await deps.versions.listForPrune(input.documentId);
      const doomed = planPrune(existing, deps.policy).filter((id) => id !== created.id);
      if (doomed.length > 0) await deps.versions.deleteVersions(doomed);

      return {
        id: created.id,
        n,
        kind: 'MANUAL',
        label,
        // Who CUT it, never who typed the words. With garbage collection on
        // there is no per-character attribution (docs/SPECS.md 5.3).
        authorName: input.authorName,
        createdAt: created.createdAt.toISOString(),
        bytes: state.byteLength,
      };
    } catch (error) {
      // `violatedUniqueIndex`, not the constraint name alone. The typed client
      // reports `meta.target: ["document_id","n"]` and never the index name, so
      // a name-only check would never fire -- and this retry, which is the whole
      // reason two people can press Save at once, would silently never happen.
      const collided = violatedUniqueIndex(error, VERSION_N_UNIQUE);
      if (!collided || attempt === VERSION_ATTEMPTS) throw error;
    }
  }

  // Unreachable: the loop either returns or throws on its last attempt. Present
  // so the function has one exit type rather than an implicit undefined.
  throw new DomainError('CONFLICT', 'Could not allocate a version number');
}
