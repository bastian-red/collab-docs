/**
 * Share links: create, list, revoke, resolve.
 *
 * The expiry rule is not here. `services/doc-access` owns it -- `resolveShareLink`
 * decides what a link is worth given the clock, and `expiryFor` turns a TTL in
 * hours into an instant -- because the same decision has to serve this API and
 * the socket handshake, and two copies of "is this link still good" would drift
 * on the day somebody changed one.
 */
import { Inject, Injectable } from '@nestjs/common';
import { expiryFor, resolveShareLink } from '@docs/doc-access';
import { DomainError, type ResolvedShare, type ShareRole } from '@docs/shared';
import { mintShareToken } from '@docs/shared/server';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { AccessService } from '../access/access.service';
import { PrismaService } from '../infra/prisma.service';
import { presentShareLink, type ShareLinkWire } from '../documents/presenters';

const LINK_SELECT = {
  id: true,
  documentId: true,
  token: true,
  role: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class ShareLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async list(documentId: string, userId: string): Promise<Array<ShareLinkWire & { url: string }>> {
    await this.access.require({ documentId, userId }, 'link.read');
    const rows = await this.prisma.client.shareLink.findMany({
      where: { documentId },
      select: LINK_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => presentShareLink(row, this.config.appBaseUrl));
  }

  /**
   * Mint a link.
   *
   * `ttlHours` has three states and each one means something different:
   * `undefined` takes the server's `SHARE_LINK_TTL_HOURS`, `null` means it never
   * expires, and a number is that many hours. That is why the contract makes the
   * field both nullable and optional -- the two are not the same answer, and
   * collapsing them would make "never expires" the accidental default.
   */
  async create(
    documentId: string,
    userId: string,
    input: { role: ShareRole; ttlHours?: number | null },
  ): Promise<ShareLinkWire & { url: string }> {
    await this.access.require({ documentId, userId }, 'link.write');

    const ttlHours = input.ttlHours === undefined ? this.config.shareLinkTtlHours : input.ttlHours;
    const row = await this.prisma.client.shareLink.create({
      data: {
        documentId,
        // 32 bytes from the system CSPRNG. Not a cuid: a cuid encodes a
        // timestamp and a counter, and a bearer credential must have no
        // structure to reason about.
        token: mintShareToken(),
        role: input.role,
        expiresAt: expiryFor(ttlHours, new Date()),
        createdById: userId,
      },
      select: LINK_SELECT,
    });
    return presentShareLink(row, this.config.appBaseUrl);
  }

  /**
   * Revoke.
   *
   * A tombstone, not a delete, so "this link was revoked" and "this link never
   * existed" stay distinguishable in the row -- which is what makes an audit
   * possible. Both still answer `GONE` on the wire, because telling a holder
   * which one they hit tells a guesser their token was real.
   *
   * Idempotent: revoking a revoked link keeps the original instant.
   * `CHECK ("revoked_at" >= "created_at")` would not catch a second UPDATE, so
   * this is here to keep the first revocation as the true one.
   */
  async revoke(
    documentId: string,
    userId: string,
    linkId: string,
  ): Promise<ShareLinkWire & { url: string }> {
    await this.access.require({ documentId, userId }, 'link.write');

    const existing = await this.prisma.client.shareLink.findUnique({
      where: { id: linkId },
      select: LINK_SELECT,
    });
    // Scoped to the document in the path. Without this a link id from another
    // document could be revoked by anybody who owns any document at all.
    if (existing === null || existing.documentId !== documentId) {
      throw new DomainError('NOT_FOUND', 'No such share link on this document.');
    }
    if (existing.revokedAt !== null) return presentShareLink(existing, this.config.appBaseUrl);

    const row = await this.prisma.client.shareLink.update({
      where: { id: linkId },
      data: { revokedAt: new Date() },
      select: LINK_SELECT,
    });
    return presentShareLink(row, this.config.appBaseUrl);
  }

  /**
   * What a token is worth, for a signed-in caller who just followed a link.
   *
   * One answer for all four refusals -- unknown, revoked, expired, presented for
   * another document -- because the difference tells a guesser which tokens were
   * real. The refusal class is logged and never sent (docs/SPECS.md 4.1 step 5).
   */
  async resolve(token: string): Promise<ResolvedShare> {
    const row = await this.prisma.client.shareLink.findUnique({
      where: { token },
      select: { documentId: true, role: true, expiresAt: true, revokedAt: true },
    });

    if (row === null) return refuse('unknown');

    // The row's own document id, because a token presented at `/share/:token`
    // is not presented FOR a document -- resolving it is how the caller learns
    // which one. The handshake is the other way round and checks the two match;
    // that is `resolveShareLink`'s `wrong-document` case and it is why the id is
    // a parameter rather than read off the row inside it.
    const verdict = resolveShareLink(row, row.documentId, new Date());
    if (!verdict.ok) return refuse(verdict.reason);

    // Checked after the verdict and answered identically: a link for a document
    // that has since been deleted must not be distinguishable from one that was
    // revoked.
    const live = await this.prisma.client.document.count({
      where: { id: row.documentId, deletedAt: null },
    });
    if (live === 0) return refuse('deleted-document');

    return {
      documentId: row.documentId,
      role: verdict.role,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
  }
}

/**
 * Every refusal, as one answer.
 *
 * The reason goes to the log and the caller gets `GONE` with a fixed sentence.
 * `never` as the return type is what lets a call site write `return refuse(...)`
 * and still satisfy a `Promise<ResolvedShare>`.
 */
function refuse(reason: string): never {
  console.warn(`[api] share link refused: ${reason}`);
  throw new DomainError('GONE', 'That link is no longer valid.');
}
