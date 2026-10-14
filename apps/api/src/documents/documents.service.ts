/**
 * Documents: the metadata half.
 *
 * **This service never writes `documents.state` and never inserts into
 * `document_updates`** (docs/SPECS.md 2.2). Creating a row is the one place it
 * comes close, and it writes `EMPTY_DOCUMENT_STATE` -- a two-byte literal from
 * `@docs/shared`, proved correct by a test in `services/doc-store` that computes
 * `Y.encodeStateAsUpdate(new Y.Doc())` and compares. Everything after that byte
 * belongs to `apps/sync`, and the boundary is enforced by resolution rather than
 * by discipline: `@docs/db/documents` publishes no `require` condition, so the
 * repository that owns those writes cannot be imported from this CommonJS
 * package at all.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DOCUMENT_SEARCH_VECTOR, Prisma } from '@docs/db';
import {
  DomainError,
  emptyDocumentStateBytes,
  type Role,
  type documentPageSchema,
} from '@docs/shared';
import type { z } from 'zod';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { AccessService } from '../access/access.service';
import { PrismaService } from '../infra/prisma.service';
import { afterCursor, decodeCursor, encodeCursor } from './cursor';
import {
  presentDocumentDetail,
  presentDocumentSummary,
  presentSearchHit,
  type DocumentDetailWire,
  type DocumentSummaryWire,
  type SearchHitWire,
} from './presenters';

/** What every list and detail read needs to build a summary. */
const SUMMARY_SELECT = {
  id: true,
  title: true,
  folderId: true,
  updatedAt: true,
  folder: { select: { name: true } },
  members: {
    select: { role: true, user: { select: { id: true, name: true } } },
    orderBy: { addedAt: 'asc' },
  },
} as const;

const DETAIL_SELECT = { ...SUMMARY_SELECT, state: true, stateSeq: true, nextSeq: true } as const;

/**
 * `ts_headline`'s markers, and why they are not the defaults.
 *
 * Postgres defaults to `StartSel=<b>, StopSel=</b>`. `content_text` is whatever
 * somebody typed into a document, so a snippet in that format would put author
 * text and server markup in one string with no way to tell them apart -- an
 * injection point the moment any renderer trusted it. `[[` and `]]` are markers
 * `presenters.splitSnippet` turns into structured segments the renderer marks up
 * itself.
 *
 * Quoted, because the options parser splits on `,` and `=` and would otherwise
 * read the brackets as syntax.
 */
const HEADLINE_OPTIONS =
  'StartSel="[[", StopSel="]]", MaxFragments=2, MinWords=6, MaxWords=24, FragmentDelimiter=" ... "';

/** The wire shape, derived from the contract the web app parses with. */
export type DocumentPage = z.input<typeof documentPageSchema>;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * The documents a person can reach, newest first.
   *
   * Scoped by membership, not by ownership: a document somebody shared with you
   * is in your list. A share LINK is not, deliberately -- a link is a way in, not
   * a filing decision, and putting every link anybody ever opened into their
   * sidebar would make the sidebar useless within a week.
   */
  async list(
    userId: string,
    options: { folderId?: string | null; deleted?: boolean; cursor?: string },
  ): Promise<DocumentPage> {
    const take = this.config.documentListPageSize;
    const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);

    const rows = await this.prisma.client.document.findMany({
      where: {
        members: { some: { userId } },
        deletedAt: options.deleted === true ? { not: null } : null,
        ...(options.folderId === undefined ? {} : { folderId: options.folderId }),
        ...(cursor === null ? {} : afterCursor(cursor)),
      },
      select: SUMMARY_SELECT,
      // The same order the cursor encodes. A list ordered one way and paged
      // another is the bug that shows up only past page one.
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      // One more than the page, so "is there another page" is answered by the
      // rows themselves rather than by a second COUNT over the same predicate.
      take: take + 1,
    });

    const page = rows.slice(0, take);
    const last = page[page.length - 1];

    return {
      documents: page.map((row) => presentDocumentSummary(row, roleOf(row.members, userId))),
      nextCursor:
        rows.length > take && last !== undefined
          ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
          : null,
    };
  }

  /**
   * Create a document, and its owner, in one statement.
   *
   * The member row is nested rather than written after, so there is no window in
   * which a document exists with nobody on it. A document with no members cannot
   * be listed, opened, deleted or shared by anybody, including whoever just made
   * it -- `resolveAccess` would answer "no access" to its own author.
   */
  async create(
    userId: string,
    input: { title: string; folderId: string | null },
  ): Promise<DocumentDetailWire> {
    if (input.folderId !== null) await this.assertOwnFolder(input.folderId, userId);

    const row = await this.prisma.client.document.create({
      data: {
        title: input.title,
        folderId: input.folderId,
        // The encoded state of an empty Y.Doc, not an empty buffer:
        // `CHECK (octet_length(state) > 0)` refuses the latter, and a row that
        // slipped past it would load as a document the sync server cannot
        // decode.
        state: Buffer.from(emptyDocumentStateBytes()),
        members: { create: { userId, role: 'OWNER' } },
      },
      select: DETAIL_SELECT,
    });

    return presentDocumentDetail(row, 'OWNER');
  }

  async detail(
    documentId: string,
    userId: string,
    shareToken: string | null,
  ): Promise<DocumentDetailWire> {
    const access = await this.access.require({ documentId, userId, shareToken }, 'document.read');

    const row = await this.prisma.client.document.findUnique({
      where: { id: documentId },
      select: DETAIL_SELECT,
    });
    // The access check already proved it exists and is not deleted, so this can
    // only be a row removed between the two queries. `NOT_FOUND` rather than a
    // 500: from the caller's seat that is exactly what happened.
    if (row === null) throw new DomainError('NOT_FOUND', 'Document not found');

    return presentDocumentDetail(row, access.role);
  }

  async rename(documentId: string, userId: string, title: string): Promise<DocumentSummaryWire> {
    const access = await this.access.require({ documentId, userId }, 'document.rename');
    const row = await this.prisma.client.document.update({
      where: { id: documentId },
      data: { title },
      select: SUMMARY_SELECT,
    });
    return presentDocumentSummary(row, access.role);
  }

  /**
   * Move a document into a folder, or out to the root.
   *
   * The target folder must be one the caller owns. Without that check a person
   * could file a document they can edit into somebody else's folder, and the
   * folder's owner would find a document in their tree that they cannot open.
   */
  async move(
    documentId: string,
    userId: string,
    folderId: string | null,
  ): Promise<DocumentSummaryWire> {
    const access = await this.access.require({ documentId, userId }, 'document.move');
    if (folderId !== null) await this.assertOwnFolder(folderId, userId);

    const row = await this.prisma.client.document.update({
      where: { id: documentId },
      data: { folderId },
      select: SUMMARY_SELECT,
    });
    return presentDocumentSummary(row, access.role);
  }

  /**
   * Soft delete.
   *
   * A tombstone rather than a DELETE, so the log, the versions and the member
   * list survive an undelete. It is also what makes the check in
   * `AccessService.resolve` load-bearing: the member rows stay, so an owner still
   * holds a role on a document that is no longer there, and every read path has
   * to ask about `deleted_at` separately from the role.
   */
  async softDelete(documentId: string, userId: string): Promise<{ deletedAt: string }> {
    await this.access.require({ documentId, userId }, 'document.delete');
    const row = await this.prisma.client.document.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
      select: { deletedAt: true },
    });
    // Non-null by construction: the update just set it.
    return { deletedAt: (row.deletedAt ?? new Date()).toISOString() };
  }

  /** The one read that deliberately looks past `deleted_at`, along with the bin listing. */
  async restore(documentId: string, userId: string): Promise<DocumentSummaryWire> {
    const access = await this.access.require(
      { documentId, userId, includeDeleted: true },
      'document.delete',
    );
    const row = await this.prisma.client.document.update({
      where: { id: documentId },
      data: { deletedAt: null },
      select: SUMMARY_SELECT,
    });
    return presentDocumentSummary(row, access.role);
  }

  /**
   * Full-text search over title and body.
   *
   * Three things here are deliberate and each one is a way this goes wrong:
   *
   * - **`websearch_to_tsquery`, not `to_tsquery`.** The latter throws a syntax
   *   error on a bare `&`, an unbalanced quote, or the word "and" -- that is, on
   *   ordinary typing. The former parses what people actually put in a search
   *   box and never raises.
   * - **`DOCUMENT_SEARCH_VECTOR` is interpolated as SQL, the query text is
   *   bound.** The vector is a frozen constant from `@docs/db`, asserted by
   *   `constraints.test.ts` to be character-for-character the expression the GIN
   *   index was built on. Postgres matches an expression index by comparing the
   *   parsed expression, so a vector written out again here with one different
   *   `coalesce` would still return correct rows -- by sequential scan, silently.
   * - **Membership is an `EXISTS`, not a join.** Only `documents` is then in the
   *   top-level `FROM`, so the unqualified `"title"` and `"content_text"` inside
   *   the constant resolve unambiguously. With a join, a future column named
   *   `title` on `document_members` would change what the index expression means.
   */
  async search(userId: string, query: string, limit: number): Promise<SearchHitWire[]> {
    const trimmed = query.trim();
    // An empty `websearch_to_tsquery` matches nothing, so this is not a
    // correctness guard -- it is a guard against issuing the query at all for
    // every keystroke that lands while the box is empty.
    if (trimmed.length === 0) return [];

    const vector = Prisma.raw(DOCUMENT_SEARCH_VECTOR);
    const rows = await this.prisma.client.$queryRaw<
      Array<{ id: string; title: string; snippet: string; rank: number; updated_at: Date }>
    >`
      SELECT "id",
             "title",
             ts_headline('english', "content_text", q, ${HEADLINE_OPTIONS}) AS snippet,
             ts_rank(${vector}, q) AS rank,
             "updated_at"
        FROM "documents", websearch_to_tsquery('english', ${trimmed}) q
       WHERE "deleted_at" IS NULL
         AND EXISTS (
               SELECT 1 FROM "document_members" m
                WHERE m."document_id" = "documents"."id" AND m."user_id" = ${userId}
             )
         AND (${vector}) @@ q
       ORDER BY rank DESC, "updated_at" DESC
       LIMIT ${limit}
    `;

    return rows.map(presentSearchHit);
  }

  /**
   * A folder must exist and belong to the caller.
   *
   * `NOT_FOUND` for somebody else's folder, not `FORBIDDEN`: folder ids are as
   * guessable as document ids, and the same anti-enumeration argument applies.
   */
  private async assertOwnFolder(folderId: string, userId: string): Promise<void> {
    const count = await this.prisma.client.folder.count({
      where: { id: folderId, ownerId: userId },
    });
    if (count === 0) throw new DomainError('NOT_FOUND', 'Folder not found');
  }
}

/** The caller's own role, out of the member list the row already carries. */
function roleOf(
  members: ReadonlyArray<{ role: Role; user: { id: string } }>,
  userId: string,
): Role {
  const own = members.find((member) => member.user.id === userId);
  // The list query filters on `members: { some: { userId } }`, so this cannot
  // miss. VIEWER is the safe floor if it ever does: the strongest role is never
  // the right thing to guess.
  return own?.role ?? 'VIEWER';
}
