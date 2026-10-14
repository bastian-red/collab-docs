/**
 * Who is on a document, and what they may do.
 *
 * Two invariants that no constraint can express on its own, both enforced here
 * inside a transaction:
 *
 * - **Exactly one OWNER.** `document_members_one_owner` is a PARTIAL unique index
 *   (`WHERE role = 'OWNER'`), so the database refuses a SECOND owner. It cannot
 *   refuse ZERO -- there is no constraint that says a row must exist -- so
 *   demoting or removing the owner is refused here, and transferring ownership
 *   demotes and promotes in one transaction.
 * - **A document always has somebody on it.** Follows from the above, and it is
 *   what stops a document becoming unreachable to everyone including the person
 *   who made it.
 */
import { Injectable } from '@nestjs/common';
import { ONE_OWNER_PER_DOCUMENT, violatedUniqueIndex } from '@docs/db';
import { DomainError, type DocumentMember, type Role, type ShareRole } from '@docs/shared';

import { AccessService } from '../access/access.service';
import { PrismaService } from '../infra/prisma.service';

const MEMBER_SELECT = {
  role: true,
  user: { select: { id: true, name: true } },
} as const;

function present(row: { role: Role; user: { id: string; name: string } }): DocumentMember {
  return { id: row.user.id, name: row.user.name, role: row.role };
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async list(
    documentId: string,
    userId: string,
    shareToken: string | null,
  ): Promise<DocumentMember[]> {
    await this.access.require({ documentId, userId, shareToken }, 'member.read');
    const rows = await this.prisma.client.documentMember.findMany({
      where: { documentId },
      select: MEMBER_SELECT,
      orderBy: { addedAt: 'asc' },
    });
    return rows.map(present);
  }

  /**
   * Add somebody by email.
   *
   * The same `NOT_FOUND` whether the address has no account or the caller
   * mistyped it, so this is not a way to ask whether a person has an account
   * here. `inviteMemberSchema` will not carry OWNER, so an invitation can never
   * be a transfer.
   */
  async invite(
    documentId: string,
    actorId: string,
    input: { email: string; role: ShareRole },
  ): Promise<DocumentMember> {
    await this.access.require({ documentId, userId: actorId }, 'member.write');

    const user = await this.prisma.client.user.findUnique({
      where: { email: input.email },
      select: { id: true, name: true },
    });
    if (user === null) throw new DomainError('NOT_FOUND', 'Nobody here uses that email address.');

    const row = await this.prisma.client.documentMember.upsert({
      where: { documentId_userId: { documentId, userId: user.id } },
      // An upsert rather than a create, so inviting somebody who is already on
      // the document changes their role instead of answering 409 for what the
      // caller plainly meant. It cannot promote to OWNER, because the schema
      // will not carry that role -- so an existing OWNER is never demoted by an
      // invitation, they are demoted by a transfer.
      create: { documentId, userId: user.id, role: input.role },
      update: { role: input.role },
      select: MEMBER_SELECT,
    });
    return present(row);
  }

  /**
   * Set a role, including the transfer of ownership.
   *
   * Three cases, and the third is the whole reason this is a transaction:
   *
   * 1. A role that is not OWNER, on somebody who is not the owner: one update.
   * 2. A role that is not OWNER, on the owner: refused. There is no constraint
   *    that says a document must have an owner, so this is the only thing
   *    stopping a document from having none.
   * 3. OWNER, on somebody else: the current owner is demoted to EDITOR and the
   *    target promoted, in one transaction. In the other order the partial
   *    unique index refuses the second statement, which would leave the document
   *    with no owner if the two were not atomic.
   */
  async setRole(
    documentId: string,
    actorId: string,
    input: { userId: string; role: Role },
  ): Promise<DocumentMember[]> {
    await this.access.require({ documentId, userId: actorId }, 'member.write');

    return this.prisma.client.$transaction(async (tx) => {
      const target = await tx.documentMember.findUnique({
        where: { documentId_userId: { documentId, userId: input.userId } },
        select: { role: true },
      });
      if (target === null)
        throw new DomainError('NOT_FOUND', 'That person is not on this document.');

      if (input.role !== 'OWNER' && target.role === 'OWNER') {
        throw new DomainError(
          'CONFLICT',
          'A document always has an owner. Transfer ownership to somebody else first.',
        );
      }

      if (input.role === 'OWNER') {
        // Demote first. The partial unique index allows at most one OWNER row,
        // so promoting first would be refused -- and outside a transaction the
        // demotion would already have committed.
        await tx.documentMember.updateMany({
          where: { documentId, role: 'OWNER' },
          data: { role: 'EDITOR' },
        });
      }

      try {
        await tx.documentMember.update({
          where: { documentId_userId: { documentId, userId: input.userId } },
          data: { role: input.role },
        });
      } catch (error) {
        // If this ever fires, two owners were about to exist and the
        // transaction is the thing that stopped it. `violatedUniqueIndex`
        // rather than the name alone: Prisma reports this partial index as
        // `meta.target: ["document_id"]`, never as its name.
        if (violatedUniqueIndex(error, ONE_OWNER_PER_DOCUMENT)) {
          throw new DomainError('CONFLICT', 'This document already has an owner.');
        }
        throw error;
      }

      const rows = await tx.documentMember.findMany({
        where: { documentId },
        select: MEMBER_SELECT,
        orderBy: { addedAt: 'asc' },
      });
      return rows.map(present);
    });
  }

  /**
   * Remove somebody, or leave.
   *
   * Two different permissions, on purpose. Removing ANOTHER person needs
   * `member.write`, which is the owner. Removing YOURSELF needs only
   * `document.read`, because leaving a document somebody shared with you is not
   * an administrative act and a viewer has no other way out of it -- their
   * sidebar would carry it forever.
   *
   * The owner cannot be removed either way, for the same reason they cannot be
   * demoted: nothing in the schema says a document must have an owner, so this
   * is what says it.
   */
  async remove(documentId: string, actorId: string, userId: string): Promise<{ userId: string }> {
    await this.access.require(
      { documentId, userId: actorId },
      userId === actorId ? 'document.read' : 'member.write',
    );

    const target = await this.prisma.client.documentMember.findUnique({
      where: { documentId_userId: { documentId, userId } },
      select: { role: true },
    });
    if (target === null) throw new DomainError('NOT_FOUND', 'That person is not on this document.');
    if (target.role === 'OWNER') {
      throw new DomainError(
        'CONFLICT',
        'A document always has an owner. Transfer ownership to somebody else first.',
      );
    }

    await this.prisma.client.documentMember.delete({
      where: { documentId_userId: { documentId, userId } },
    });
    return { userId };
  }
}
