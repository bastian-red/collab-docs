/**
 * Database rows to wire shapes.
 *
 * Pure functions over plain objects, which is what makes them the API's gate
 * lane: every one of them is asserted against the zod schema in `@docs/shared`
 * that the client parses with, so a drifted field is a failed test rather than a
 * runtime `undefined` in somebody's sidebar.
 *
 * ---------------------------------------------------------------------------
 * Why the return types are `z.input` and not `z.infer`
 *
 * `documentDetailSchema` carries `seqSchema`, which TRANSFORMS a string or a
 * number into a `bigint`. `z.infer` is therefore the shape a CLIENT gets after
 * parsing, and it is not the shape a server may send: `JSON.stringify` throws
 * `TypeError: Do not know how to serialize a BigInt`, and Nest's serialiser
 * would take the whole response down.
 *
 * `z.input` is the other side of the same schema -- what goes on the wire -- so
 * naming it here makes the compiler enforce the direction rather than leaving it
 * to a comment. `seq` values become strings, which is also the only lossless way
 * to put a 64-bit integer in JSON.
 */
import {
  documentDetailSchema,
  documentSummarySchema,
  folderSchema,
  searchHitSchema,
  shareLinkSchema,
  shareLinkUrl,
  versionSummarySchema,
  type Role,
  type VersionKind,
} from '@docs/shared';
import type { z } from 'zod';

export type DocumentSummaryWire = z.input<typeof documentSummarySchema>;
export type DocumentDetailWire = z.input<typeof documentDetailSchema>;
export type FolderWire = z.input<typeof folderSchema>;
export type SearchHitWire = z.input<typeof searchHitSchema>;
export type ShareLinkWire = z.input<typeof shareLinkSchema>;
export type VersionSummaryWire = z.input<typeof versionSummarySchema>;

/** The columns and relations a summary needs. Structural, so a test can build one. */
export interface DocumentRow {
  readonly id: string;
  readonly title: string;
  readonly folderId: string | null;
  readonly folder: { readonly name: string } | null;
  readonly updatedAt: Date;
  readonly members: ReadonlyArray<{
    readonly role: Role;
    readonly user: { readonly id: string; readonly name: string };
  }>;
}

export interface DocumentStateRow extends DocumentRow {
  readonly stateSeq: bigint;
  readonly nextSeq: bigint;
  readonly state: Uint8Array;
}

export function presentDocumentSummary(row: DocumentRow, role: Role): DocumentSummaryWire {
  return {
    id: row.id,
    title: row.title,
    folderId: row.folderId,
    // `folder.name` rather than a second query. Null when the document sits at
    // the root, which is a different thing from a folder whose name is empty --
    // `nameSchema` forbids the latter.
    folderName: row.folder?.name ?? null,
    role,
    updatedAt: row.updatedAt.toISOString(),
    members: row.members.map((member) => ({
      id: member.user.id,
      name: member.user.name,
      role: member.role,
    })),
  };
}

export function presentDocumentDetail(row: DocumentStateRow, role: Role): DocumentDetailWire {
  return {
    ...presentDocumentSummary(row, role),
    // Strings, not numbers. `next_seq` is a BigInt in Postgres, and a document
    // edited for long enough would pass 2^53 and start losing its low bits in
    // JSON -- silently, and in the one number the persistence design is read
    // from.
    stateSeq: row.stateSeq.toString(),
    nextSeq: row.nextSeq.toString(),
    stateBytes: row.state.byteLength,
  };
}

export interface FolderRow {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly _count: { readonly documents: number };
}

export function presentFolder(row: FolderRow): FolderWire {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    documentCount: row._count.documents,
  };
}

export interface VersionRow {
  readonly id: string;
  readonly n: number;
  readonly kind: VersionKind;
  readonly label: string | null;
  readonly author: { readonly name: string } | null;
  readonly createdAt: Date;
  readonly state: Uint8Array;
}

/**
 * A version, for the panel.
 *
 * `authorName` is who **cut** the version, and the field is named for that. With
 * garbage collection on there is no per-character attribution (docs/SPECS.md
 * 5.3), and a field called `author` beside a diff would imply there is.
 */
export function presentVersion(row: VersionRow): VersionSummaryWire {
  return {
    id: row.id,
    n: row.n,
    kind: row.kind,
    label: row.label,
    authorName: row.author?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    bytes: row.state.byteLength,
  };
}

export interface ShareLinkRowFull {
  readonly id: string;
  readonly documentId: string;
  readonly token: string;
  readonly role: Role;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * A share link, with its URL already built.
 *
 * The URL is assembled here rather than in the browser so the API and the web
 * app cannot disagree about the route: `shareLinkUrl` lives in `@docs/shared`
 * beside `documentRoom` and for the same reason (a drifted path is silently
 * successful -- the link is valid and the page 404s).
 *
 * `role` is narrowed to a shareable one by `CHECK (role <> 'OWNER')`, by
 * `SHARE_ROLES`, and by `resolveShareLink`. The cast records that this is the
 * fourth place the same fact is known, not a place it is assumed.
 */
export function presentShareLink(
  row: ShareLinkRowFull,
  appBaseUrl: string,
): ShareLinkWire & { url: string } {
  return {
    id: row.id,
    token: row.token,
    role: row.role as Exclude<Role, 'OWNER'>,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    url: shareLinkUrl(appBaseUrl, row.documentId, row.token),
  };
}

/**
 * `ts_headline`'s markers, split out of the snippet.
 *
 * Postgres defaults to `<b>` and `</b>`, which is HTML this API must not put on
 * the wire: `content_text` is whatever somebody typed into a document, and a
 * snippet that mixed the two would be an injection point the moment any renderer
 * trusted it. So the query asks for `[[` and `]]` instead, and this turns them
 * into structured segments the renderer marks up itself.
 *
 * An unpaired marker is not an error and is not stripped: `ts_headline` can cut
 * a fragment mid-highlight, and text is never dropped from a search result.
 */
export const HEADLINE_START = '[[';
export const HEADLINE_STOP = ']]';

export interface SnippetSegment {
  readonly text: string;
  readonly match: boolean;
}

export function splitSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let rest = snippet;

  while (rest.length > 0) {
    const start = rest.indexOf(HEADLINE_START);
    if (start === -1) break;
    const stop = rest.indexOf(HEADLINE_STOP, start + HEADLINE_START.length);
    if (stop === -1) break;

    if (start > 0) segments.push({ text: rest.slice(0, start), match: false });
    segments.push({ text: rest.slice(start + HEADLINE_START.length, stop), match: true });
    rest = rest.slice(stop + HEADLINE_STOP.length);
  }

  if (rest.length > 0) segments.push({ text: rest, match: false });
  return segments.filter((segment) => segment.text.length > 0);
}

export interface SearchRow {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly rank: number;
  readonly updated_at: Date;
}

export function presentSearchHit(row: SearchRow): SearchHitWire {
  return {
    id: row.id,
    title: row.title,
    snippet: row.snippet,
    rank: row.rank,
    updatedAt: row.updated_at.toISOString(),
  };
}
