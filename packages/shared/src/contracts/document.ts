import { z } from 'zod';

import {
  documentTitleSchema,
  idSchema,
  instantSchema,
  nameSchema,
  roleSchema,
  seqSchema,
} from './primitives';

/**
 * A person on a document, as the sidebar and the share dialog render them.
 *
 * Named rather than inlined into `documentSummarySchema`, because the members
 * endpoint returns exactly this list and a second inline copy of the shape is a
 * second thing to keep in step.
 */
export const documentMemberSchema = z.object({
  id: idSchema,
  name: nameSchema,
  role: roleSchema,
});

export const documentSummarySchema = z.object({
  id: idSchema,
  title: documentTitleSchema,
  folderId: idSchema.nullable(),
  folderName: z.string().nullable(),
  /** The caller's own role on this document, already resolved by the API. */
  role: roleSchema,
  updatedAt: instantSchema,
  members: z.array(documentMemberSchema),
});

export const documentDetailSchema = documentSummarySchema.extend({
  /**
   * Where the log stands. Exposed because it is the number that makes the
   * persistence design legible from outside -- `/status` and the E2E suite both
   * assert on it, and a checkpoint that never advances is visible here before it
   * is visible as slow loading.
   */
  stateSeq: seqSchema,
  nextSeq: seqSchema,
  /** Encoded size of the checkpoint, against `DOCUMENT_MAX_BYTES`. */
  stateBytes: z.number().int().nonnegative(),
});

export const createDocumentSchema = z.object({
  title: documentTitleSchema,
  folderId: idSchema
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});

export const renameDocumentSchema = z.object({ title: documentTitleSchema });

export const moveDocumentSchema = z.object({
  folderId: idSchema.nullable().transform((v) => v ?? null),
});

export const folderSchema = z.object({
  id: idSchema,
  name: nameSchema,
  parentId: idSchema.nullable(),
  documentCount: z.number().int().nonnegative(),
});

export const createFolderSchema = z.object({
  name: nameSchema,
  parentId: idSchema
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});

/**
 * A full-text hit. `snippet` comes from `ts_headline` and therefore contains
 * markers the renderer has to interpret; it is never inserted as HTML.
 */
export const searchHitSchema = z.object({
  id: idSchema,
  title: documentTitleSchema,
  snippet: z.string(),
  rank: z.number(),
  updatedAt: instantSchema,
});

/**
 * One page of the document list.
 *
 * `nextCursor` is opaque (base64url of `(updatedAt, id)`, see
 * `apps/api/src/documents/cursor.ts`) and null on the last page. It lived as a
 * TypeScript interface inside `apps/api` until the web app needed to parse it,
 * which is exactly the moment an interface beside no schema becomes two shapes
 * that can drift (docs/CODESTYLE.md section 2).
 */
export const documentPageSchema = z.object({
  documents: z.array(documentSummarySchema),
  nextCursor: z.string().min(1).nullable(),
});

export type DocumentMember = z.infer<typeof documentMemberSchema>;
export type DocumentSummary = z.infer<typeof documentSummarySchema>;
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type Folder = z.infer<typeof folderSchema>;
export type SearchHit = z.infer<typeof searchHitSchema>;
export type DocumentPage = z.infer<typeof documentPageSchema>;
