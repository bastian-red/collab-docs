/**
 * Version history, read side.
 *
 * **Everything here is a read**, and that is the boundary rather than an
 * accident. A version row is a full `Y.encodeStateAsUpdate`, so writing one means
 * knowing the document's live state -- the checkpoint plus its un-compacted log --
 * which only `apps/sync` has. Cutting a version from `documents.state` alone
 * would quietly save a document several paragraphs behind what the author is
 * looking at.
 *
 * So: `apps/sync` cuts versions (automatically at compaction, and on request at
 * `POST /documents/:id/versions`) and computes diffs, because both need a
 * `Y.Doc`. This API lists them and hands back the bytes a client needs to
 * restore one. The split is not a convention -- `@docs/db/documents` publishes no
 * `require` condition, so this CommonJS package cannot reach the write path at
 * all (docs/CODESTYLE.md section 9).
 */
import { Injectable } from '@nestjs/common';
import { DomainError, type versionStateSchema } from '@docs/shared';
import type { z } from 'zod';

import { AccessService } from '../access/access.service';
import { PrismaService } from '../infra/prisma.service';
import { presentVersion, type VersionSummaryWire } from '../documents/presenters';

const VERSION_SELECT = {
  id: true,
  n: true,
  kind: true,
  label: true,
  createdAt: true,
  state: true,
  author: { select: { name: true } },
} as const;

/** A version's stored state. The contract is `versionStateSchema` in `@docs/shared`. */
export type VersionState = z.input<typeof versionStateSchema>;

@Injectable()
export class VersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async list(
    documentId: string,
    userId: string,
    shareToken: string | null,
  ): Promise<VersionSummaryWire[]> {
    await this.access.require({ documentId, userId, shareToken }, 'version.read');
    const rows = await this.prisma.client.documentVersion.findMany({
      where: { documentId },
      select: VERSION_SELECT,
      // Newest first, by `n` and not by `createdAt`. `n` is allocated under a
      // unique constraint, so two versions can share a millisecond but not a
      // number, and the panel's order is then the same on every render.
      orderBy: { n: 'desc' },
    });
    return rows.map(presentVersion);
  }

  /**
   * One version's bytes.
   *
   * `version.read` and not `version.restore`, deliberately. This endpoint hands
   * back a document the caller can already read, so gating it on the stronger
   * permission would protect nothing -- and the restore itself is not this
   * endpoint. A restore is an ordinary edit made by the client (docs/SPECS.md
   * 5.2), so it is refused where every other write is: a `COMMENTER` or `VIEWER`
   * holds a read-only socket and the sync server drops the transaction.
   */
  async state(
    documentId: string,
    n: number,
    userId: string,
    shareToken: string | null,
  ): Promise<VersionState> {
    await this.access.require({ documentId, userId, shareToken }, 'version.read');

    const row = await this.prisma.client.documentVersion.findUnique({
      where: { documentId_n: { documentId, n } },
      select: { n: true, state: true },
    });
    if (row === null)
      throw new DomainError('NOT_FOUND', `No version ${String(n)} of this document`);

    return { n: row.n, state: Buffer.from(row.state).toString('base64') };
  }
}
