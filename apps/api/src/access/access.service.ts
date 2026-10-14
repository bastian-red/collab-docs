/**
 * The one place this API asks "who is this caller on this document".
 *
 * Every controller goes through it, and none of them re-states the rule: the
 * matrix lives in `@docs/shared`, the resolution lives in `services/doc-access`,
 * and this class is the Prisma half -- the three queries those pure functions
 * need, and nothing else. `apps/sync/src/auth.ts` is the same decision reached
 * over a websocket handshake, built from the same two modules.
 *
 * **The soft-delete check is separate from the role check, and comes first.**
 * `document_members` rows outlive a soft delete -- nothing cleans them up, and
 * cleaning them up would make an undelete lose everybody's access -- so an owner
 * still has a role on a document that has been deleted. Deciding on the role
 * alone would let the owner of a deleted document keep renaming it, sharing it,
 * and reading it. `apps/sync` had exactly this hole and it is closed the same way
 * on both sides.
 */
import { Injectable } from '@nestjs/common';
import {
  requireAction,
  resolveAccess,
  type Access,
  type AccessOutcome,
  type ShareLinkRow,
} from '@docs/doc-access';
import type { Action, Role } from '@docs/shared';

import { PrismaService } from '../infra/prisma.service';

export interface AccessQuery {
  readonly documentId: string;
  readonly userId: string;
  /** The `?share=` token the caller presented, if any. Never "the link that exists". */
  readonly shareToken?: string | null;
  /**
   * Whether a soft-deleted document counts as existing.
   *
   * True for exactly two callers: restoring a document and listing the bin.
   * Everything else must treat a deleted document as absent, or the product has
   * no delete.
   */
  readonly includeDeleted?: boolean;
}

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's effective role, or a denial.
   *
   * The three lookups run together because none depends on another, and the
   * document-existence one is not skippable: it is the query that reads
   * `deleted_at IS NULL`.
   */
  async resolve(query: AccessQuery): Promise<AccessOutcome> {
    const token = query.shareToken ?? null;

    const [exists, membership, shareLink] = await Promise.all([
      this.documentExists(query.documentId, query.includeDeleted === true),
      this.membership(query.documentId, query.userId),
      token === null || token === '' ? Promise.resolve(null) : this.shareLink(token),
    ]);

    // A denial with no link refusal, which is what `requireAction` turns into a
    // 404. Deliberately indistinguishable from "you are not a member": a caller
    // must not learn that a document id was real by deleting it and asking.
    if (!exists) return { ok: false, denial: { linkRefusal: null } };

    return resolveAccess(
      query.documentId,
      { membership, shareLink, presentedToken: token },
      new Date(),
    );
  }

  /**
   * Resolve and assert in one call, which is what a controller wants.
   *
   * Throws `NOT_FOUND` for no access at all and `FORBIDDEN` for a role that is
   * too weak; the difference is a security property and it is explained where
   * `requireAction` is defined.
   */
  async require(query: AccessQuery, action: Action): Promise<Access> {
    return requireAction(await this.resolve(query), action);
  }

  /** The role a caller holds directly, ignoring any link. */
  async membership(documentId: string, userId: string): Promise<Role | null> {
    const row = await this.prisma.client.documentMember.findUnique({
      where: { documentId_userId: { documentId, userId } },
      select: { role: true },
    });
    return row?.role ?? null;
  }

  async shareLink(token: string): Promise<ShareLinkRow | null> {
    return this.prisma.client.shareLink.findUnique({
      where: { token },
      select: { documentId: true, role: true, expiresAt: true, revokedAt: true },
    });
  }

  async documentExists(documentId: string, includeDeleted: boolean): Promise<boolean> {
    const count = await this.prisma.client.document.count({
      where: { id: documentId, ...(includeDeleted ? {} : { deletedAt: null }) },
    });
    return count > 0;
  }
}
