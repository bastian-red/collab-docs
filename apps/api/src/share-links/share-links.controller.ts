/**
 * `/documents/:documentId/links` and `/share/:token`.
 *
 * Two controllers in one file because they are two halves of one feature: one
 * mints the credential, the other spends it.
 *
 * Neither is `@Public()`. Resolving a token still needs a signed-in caller -- the
 * web app sends somebody to sign in first and then follows the link -- because a
 * public resolve endpoint is an oracle anybody can iterate against, and the
 * throttler's per-address budget is the only thing that would be in the way.
 */
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { createShareLinkSchema, idSchema } from '@docs/shared';
import type { ResolvedShare, SessionUser } from '@docs/shared';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { ShareLinksService } from './share-links.service';
import { ZodPipe } from '../common/zod.pipe';
import type { ShareLinkWire } from '../documents/presenters';

const tokenSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

@Controller('documents/:documentId/links')
export class ShareLinksController {
  constructor(private readonly links: ShareLinksService) {}

  @Get()
  list(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
  ): Promise<Array<ShareLinkWire & { url: string }>> {
    return this.links.list(documentId, user.id);
  }

  @Post()
  create(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Body(new ZodPipe(createShareLinkSchema)) input: z.infer<typeof createShareLinkSchema>,
  ): Promise<ShareLinkWire & { url: string }> {
    return this.links.create(documentId, user.id, input);
  }

  /**
   * `POST .../revoke` rather than `DELETE .../:linkId`.
   *
   * The row is not removed. A revoked link is a tombstone, so "revoked" and
   * "never existed" stay distinguishable in an audit even though both answer the
   * same `GONE` on the wire.
   */
  @Post(':linkId/revoke')
  revoke(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Param('linkId', new ZodPipe(idSchema)) linkId: string,
  ): Promise<ShareLinkWire & { url: string }> {
    return this.links.revoke(documentId, user.id, linkId);
  }
}

@Controller('share')
export class ShareController {
  constructor(private readonly links: ShareLinksService) {}

  @Get(':token')
  resolve(
    @CurrentUser() _user: SessionUser,
    @Param('token', new ZodPipe(tokenSchema)) token: string,
  ): Promise<ResolvedShare> {
    return this.links.resolve(token);
  }
}
