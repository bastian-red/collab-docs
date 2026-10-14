import {
  documentPageSchema,
  documentPath,
  folderSchema,
  relativeTime,
  searchHitSchema,
  type DocumentSummary,
  type Role,
} from '@docs/shared';
import Link from 'next/link';
import { z } from 'zod';

import { Avatar } from '../../components/avatar';
import { LibraryRail } from '../../components/library-rail';
import { SearchField } from '../../components/search-field';
import { Snippet } from '../../components/snippet';
import { ApiError, apiFetch, query } from '../../lib/api';
import { requireUser } from '../../lib/session';
import { restoreDocumentAction } from './actions';

export const metadata = { title: 'Documents' };

const ROLE_WORD: Readonly<Record<Role, string>> = {
  OWNER: 'Owner',
  EDITOR: 'Editor',
  COMMENTER: 'Commenter',
  VIEWER: 'Viewer',
};

interface ListParams {
  folder?: string;
  view?: string;
  q?: string;
  cursor?: string;
}

/**
 * The document list, search and trash, in one server component.
 *
 * Every read is server-side with a fresh service token (docs/SPECS.md 12.3). The
 * page answers an API error by rendering it, with its code, in an alert panel: a
 * list that 500s cannot tell the reader whether they have no documents or the API
 * is down, and those call for different actions.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<ListParams>;
}) {
  const params = await searchParams;
  const here = `/${query({ folder: params.folder, view: params.view, q: params.q })}`;
  const user = await requireUser(here);

  const trash = params.view === 'trash';
  const search =
    typeof params.q === 'string' && params.q.trim().length > 0
      ? params.q.trim().slice(0, 200)
      : null;
  const folder = !trash && params.folder ? params.folder : undefined;
  const current = trash ? 'trash' : (folder ?? 'all');
  const now = Date.now();

  let error: ApiError | null = null;
  let folders: z.infer<typeof folderSchema>[] = [];
  let page: z.infer<typeof documentPageSchema> | null = null;
  let hits: z.infer<typeof searchHitSchema>[] | null = null;

  try {
    [folders, page, hits] = await Promise.all([
      apiFetch(user, '/folders', z.array(folderSchema)),
      search === null
        ? apiFetch(
            user,
            `/documents${query({ folderId: folder, deleted: trash ? 'true' : undefined, cursor: params.cursor })}`,
            documentPageSchema,
          )
        : Promise.resolve(null),
      search === null
        ? Promise.resolve(null)
        : apiFetch(user, `/documents/search${query({ q: search })}`, z.array(searchHitSchema)),
    ]);
  } catch (caught) {
    if (!(caught instanceof ApiError)) throw caught;
    error = caught;
  }

  const folderName = folders.find((entry) => entry.id === folder)?.name;
  const heading = search
    ? `Search results`
    : trash
      ? 'Trash'
      : folder === 'root'
        ? 'Not in a folder'
        : (folderName ?? 'All documents');

  return (
    <div className="library">
      <LibraryRail user={user} folders={folders} current={current} />
      <main id="main" className="library-main">
        <header className="library-header">
          <h1 className="library-title">{heading}</h1>
          <SearchField initial={search ?? ''} />
        </header>

        {error !== null ? (
          <div className="panel-error" role="alert">
            <p>{error.message}</p>
            <p className="mono">{error.code}</p>
          </div>
        ) : hits !== null ? (
          <SearchResults hits={hits} query={search ?? ''} now={now} />
        ) : page !== null ? (
          <DocumentTable
            documents={page.documents}
            trash={trash}
            now={now}
            nextCursor={page.nextCursor}
            here={here}
          />
        ) : null}
      </main>
    </div>
  );
}

function DocumentTable({
  documents,
  trash,
  now,
  nextCursor,
  here,
}: {
  readonly documents: DocumentSummary[];
  readonly trash: boolean;
  readonly now: number;
  readonly nextCursor: string | null;
  readonly here: string;
}) {
  if (documents.length === 0) {
    return (
      <p className="empty">
        {trash ? 'Trash is empty.' : 'No documents yet. Start one with New document.'}
      </p>
    );
  }

  return (
    <>
      <table className="doc-table">
        <caption className="sr-only">{trash ? 'Documents in the trash' : 'Documents'}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Shared with</th>
            <th scope="col">Edited</th>
            <th scope="col">Access</th>
            {trash ? (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.id}>
              <th scope="row" className="doc-name">
                {trash ? (
                  <span className="doc-title">{document.title}</span>
                ) : (
                  <Link className="doc-title" href={documentPath(document.id)}>
                    {document.title}
                  </Link>
                )}
                {document.folderName ? (
                  <span className="doc-folder">{document.folderName}</span>
                ) : null}
              </th>
              <td>
                <People members={document.members} />
              </td>
              <td>
                <time dateTime={document.updatedAt}>
                  {relativeTime(new Date(document.updatedAt), now)}
                </time>
              </td>
              <td>{ROLE_WORD[document.role]}</td>
              {trash ? (
                <td>
                  <form action={restoreDocumentAction}>
                    <input type="hidden" name="documentId" value={document.id} />
                    <button className="button button-quiet" type="submit">
                      Restore<span className="sr-only"> {document.title}</span>
                    </button>
                  </form>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {nextCursor === null ? null : (
        <p className="pager">
          <Link
            className="button button-quiet"
            href={`${here}${here.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(nextCursor)}`}
          >
            Older documents
          </Link>
        </p>
      )}
    </>
  );
}

function People({ members }: { readonly members: DocumentSummary['members'] }) {
  if (members.length <= 1) return <span className="muted">Only you</span>;
  const shown = members.slice(0, 3);
  return (
    <span className="people">
      {shown.map((member) => (
        <Avatar key={member.id} userId={member.id} name={member.name} />
      ))}
      <span className="people-text">
        {members.length} people
        <span className="sr-only">: {members.map((member) => member.name).join(', ')}</span>
      </span>
    </span>
  );
}

function SearchResults({
  hits,
  query: text,
  now,
}: {
  readonly hits: z.infer<typeof searchHitSchema>[];
  readonly query: string;
  readonly now: number;
}) {
  if (hits.length === 0) {
    return (
      <p className="empty">
        Nothing matches <q>{text}</q>.
      </p>
    );
  }
  return (
    <ol className="hits" aria-label={`${hits.length} results for ${text}`}>
      {hits.map((hit) => (
        <li key={hit.id} className="hit-row">
          <Link className="doc-title" href={documentPath(hit.id)}>
            {hit.title}
          </Link>
          <p className="hit-snippet">
            <Snippet text={hit.snippet} />
          </p>
          <time className="muted" dateTime={hit.updatedAt}>
            {relativeTime(new Date(hit.updatedAt), now)}
          </time>
        </li>
      ))}
    </ol>
  );
}
