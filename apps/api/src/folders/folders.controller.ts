/**
 * `/folders`.
 *
 * No `?share=` anywhere: folders are not shared (see `FoldersService.list`), so
 * every route here is scoped to the caller's own tree by ownership alone.
 */
import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { createFolderSchema, idSchema, nameSchema } from '@docs/shared';
import type { SessionUser } from '@docs/shared';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { FoldersService } from './folders.service';
import { ZodPipe } from '../common/zod.pipe';
import type { FolderWire } from '../documents/presenters';

const renameFolderSchema = z.object({ name: nameSchema });
const moveFolderSchema = z.object({
  parentId: idSchema
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

@Controller('folders')
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get()
  list(@CurrentUser() user: SessionUser): Promise<FolderWire[]> {
    return this.folders.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(createFolderSchema)) input: z.infer<typeof createFolderSchema>,
  ): Promise<FolderWire> {
    return this.folders.create(user.id, input);
  }

  @Patch(':folderId')
  rename(
    @CurrentUser() user: SessionUser,
    @Param('folderId', new ZodPipe(idSchema)) folderId: string,
    @Body(new ZodPipe(renameFolderSchema)) input: z.infer<typeof renameFolderSchema>,
  ): Promise<FolderWire> {
    return this.folders.rename(folderId, user.id, input.name);
  }

  @Post(':folderId/move')
  move(
    @CurrentUser() user: SessionUser,
    @Param('folderId', new ZodPipe(idSchema)) folderId: string,
    @Body(new ZodPipe(moveFolderSchema)) input: z.infer<typeof moveFolderSchema>,
  ): Promise<FolderWire> {
    return this.folders.move(folderId, user.id, input.parentId);
  }

  @Delete(':folderId')
  remove(
    @CurrentUser() user: SessionUser,
    @Param('folderId', new ZodPipe(idSchema)) folderId: string,
  ): Promise<{ id: string }> {
    return this.folders.remove(folderId, user.id);
  }
}
