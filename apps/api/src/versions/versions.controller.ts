/**
 * `/documents/:documentId/versions`, read only.
 *
 * There is no `POST` here and no restore endpoint, and both absences are the
 * design rather than an omission. Cutting a version needs the live document,
 * which lives in `apps/sync`; restoring one is an ordinary edit the client makes
 * over the socket (docs/SPECS.md 5.2), which is what makes "a viewer cannot
 * restore" fall out of the read-only connection instead of being restated here.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { idSchema } from '@docs/shared';
import type { SessionUser } from '@docs/shared';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { VersionsService, type VersionState } from './versions.service';
import { ZodPipe } from '../common/zod.pipe';
import type { VersionSummaryWire } from '../documents/presenters';

const shareQuerySchema = z.object({
  share: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
});

/** A version number off the path: a positive integer, and never `seq`. */
const versionNumberParam = z
  .string()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(z.number().int().positive());

@Controller('documents/:documentId/versions')
export class VersionsController {
  constructor(private readonly versions: VersionsService) {}

  @Get()
  list(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Query(new ZodPipe(shareQuerySchema)) query: z.infer<typeof shareQuerySchema>,
  ): Promise<VersionSummaryWire[]> {
    return this.versions.list(documentId, user.id, query.share ?? null);
  }

  @Get(':n/state')
  state(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Param('n', new ZodPipe(versionNumberParam)) n: number,
    @Query(new ZodPipe(shareQuerySchema)) query: z.infer<typeof shareQuerySchema>,
  ): Promise<VersionState> {
    return this.versions.state(documentId, n, user.id, query.share ?? null);
  }
}
