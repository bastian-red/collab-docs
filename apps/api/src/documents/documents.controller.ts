/**
 * `/documents`: the list, one document, and the metadata writes.
 *
 * `?share=` appears on the read route and nowhere else. A share link grants
 * `VIEWER` or `COMMENTER` at most, and no write action is reachable from either
 * (`@docs/shared`'s matrix), so accepting the parameter on a write route would be
 * a way to be told "forbidden" more slowly. The read route needs it because
 * opening a shared link is the whole feature.
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createDocumentSchema,
  idSchema,
  moveDocumentSchema,
  renameDocumentSchema,
} from '@docs/shared';
import type { SessionUser } from '@docs/shared';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { DocumentsService, type DocumentPage } from './documents.service';
import { ZodPipe } from '../common/zod.pipe';
import type { DocumentDetailWire, DocumentSummaryWire, SearchHitWire } from './presenters';

/**
 * Query parameters arrive as strings or not at all, so they get their own
 * schemas rather than reusing the body ones.
 *
 * Coercing inside the shared schemas would make `createDocumentSchema.parse`
 * accept a string where the contract says a boolean, on the client too, which is
 * where a string would be a bug worth catching.
 */
const listQuerySchema = z.object({
  // Three states: absent (every folder), the literal `root` (documents with no
  // folder), or an id. `folderId=` with an empty value is not a fourth state --
  // it is a client that built a URL from an undefined variable, and it is
  // refused rather than silently meaning "everything".
  folderId: z.union([z.literal('root'), idSchema]).optional(),
  deleted: z.enum(['true', 'false']).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .optional(),
});

const shareQuerySchema = z.object({
  // A share token is 32 random bytes in base64url. Bounded and character-checked
  // here so an absurd query string never reaches a database lookup.
  share: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
});

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(
    @CurrentUser() user: SessionUser,
    @Query(new ZodPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<DocumentPage> {
    return this.documents.list(user.id, {
      ...(query.folderId === undefined
        ? {}
        : { folderId: query.folderId === 'root' ? null : query.folderId }),
      deleted: query.deleted === 'true',
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  /**
   * Search, before the `:documentId` route.
   *
   * Declaration order decides which route matches in Nest, and `search` would
   * otherwise be read as a document id: the request reaches `detail`, `idSchema`
   * refuses it, and the endpoint answers 400 for a perfectly good search.
   */
  @Get('search')
  search(
    @CurrentUser() user: SessionUser,
    @Query(new ZodPipe(searchQuerySchema)) query: z.infer<typeof searchQuerySchema>,
  ): Promise<SearchHitWire[]> {
    return this.documents.search(user.id, query.q, query.limit ?? 20);
  }

  @Post()
  create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(createDocumentSchema)) input: z.infer<typeof createDocumentSchema>,
  ): Promise<DocumentDetailWire> {
    return this.documents.create(user.id, input);
  }

  @Get(':documentId')
  detail(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Query(new ZodPipe(shareQuerySchema)) query: z.infer<typeof shareQuerySchema>,
  ): Promise<DocumentDetailWire> {
    return this.documents.detail(documentId, user.id, query.share ?? null);
  }

  @Patch(':documentId')
  rename(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Body(new ZodPipe(renameDocumentSchema)) input: z.infer<typeof renameDocumentSchema>,
  ): Promise<DocumentSummaryWire> {
    return this.documents.rename(documentId, user.id, input.title);
  }

  /**
   * `POST .../move` rather than a field on `PATCH`.
   *
   * Moving is the one metadata write with a permission of its own -- `OWNER`
   * only, while `EDITOR` may rename -- so folding it into the rename body would
   * mean one endpoint with two different answers depending on which fields were
   * present.
   */
  @Post(':documentId/move')
  move(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
    @Body(new ZodPipe(moveDocumentSchema)) input: z.infer<typeof moveDocumentSchema>,
  ): Promise<DocumentSummaryWire> {
    return this.documents.move(documentId, user.id, input.folderId);
  }

  @Delete(':documentId')
  remove(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
  ): Promise<{ deletedAt: string }> {
    return this.documents.softDelete(documentId, user.id);
  }

  @Post(':documentId/restore')
  restore(
    @CurrentUser() user: SessionUser,
    @Param('documentId', new ZodPipe(idSchema)) documentId: string,
  ): Promise<DocumentSummaryWire> {
    return this.documents.restore(documentId, user.id);
  }
}
