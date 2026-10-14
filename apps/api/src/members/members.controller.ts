/**
 * `/documents/:documentId/members`.
 *
 * `?share=` is accepted on the read route only. `member.read` is in the matrix
 * for `COMMENTER` and above, so somebody holding a commenting link can see who
 * else is on the document -- which is what makes a presence list mean anything to
 * them. Every write here needs `member.write`, which no link can grant.
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { idSchema, inviteMemberSchema, setMemberRoleSchema } from '@docs/shared';
import type { DocumentMember, SessionUser } from '@docs/shared';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { MembersService } from './members.service';
import { ZodPipe } from '../common/zod.pipe';

const shareQuerySchema = z.object({
  share: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
});

@Controller('documents/:documentId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  list(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Query(new ZodPipe(shareQuerySchema)) query: z.infer<typeof shareQuerySchema>,
  ): Promise<DocumentMember[]> {
    return this.members.list(documentId, user.id, query.share ?? null);
  }

  @Post()
  invite(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Body(new ZodPipe(inviteMemberSchema)) input: z.infer<typeof inviteMemberSchema>,
  ): Promise<DocumentMember> {
    return this.members.invite(documentId, user.id, input);
  }

  /**
   * `PUT` on the collection rather than `PATCH` on `:userId`.
   *
   * Setting a role to OWNER changes two rows -- the old owner is demoted in the
   * same transaction -- so the response is the whole member list. A `PATCH` on
   * one member that silently altered another would be a lie about what happened.
   */
  @Put()
  setRole(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Body(new ZodPipe(setMemberRoleSchema)) input: z.infer<typeof setMemberRoleSchema>,
  ): Promise<DocumentMember[]> {
    return this.members.setRole(documentId, user.id, input);
  }

  @Delete(':userId')
  remove(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Param('userId', new ZodPipe(idSchema)) userId: string,
  ): Promise<{ userId: string }> {
    return this.members.remove(documentId, user.id, userId);
  }
}
