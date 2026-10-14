import type { Folder, SessionUser } from '@docs/shared';
import Link from 'next/link';

import { createDocumentAction, signOutAction } from '../app/(app)/actions';
import { Avatar } from './avatar';

interface LibraryRailProps {
  readonly user: SessionUser;
  readonly folders: Folder[];
  /** `all`, `root` (no folder), `trash`, or a folder id. */
  readonly current: string;
}

/**
 * The left rail: new document, library views, folders, and who is signed in.
 *
 * Links, not buttons, because each entry is a place with a URL somebody can open
 * in a new tab. `aria-current="page"` marks the active one, which is what a
 * screen reader announces; the highlight is the visual echo of it.
 */
export function LibraryRail({ user, folders, current }: LibraryRailProps) {
  const top = folders.filter((folder) => folder.parentId === null);
  const childrenOf = (parentId: string) => folders.filter((folder) => folder.parentId === parentId);
  const folderForNew =
    current === 'all' || current === 'root' || current === 'trash' ? '' : current;

  return (
    <nav className="rail" aria-label="Library">
      <p className="brand">collab-docs</p>
      <form action={createDocumentAction}>
        <input type="hidden" name="folderId" value={folderForNew} />
        <button className="button button-primary rail-new" type="submit">
          New document
        </button>
      </form>

      <h2 className="rail-heading">Library</h2>
      <ul className="rail-list">
        <RailLink href="/" label="All documents" active={current === 'all'} />
        <RailLink href="/?folder=root" label="Not in a folder" active={current === 'root'} />
        <RailLink href="/?view=trash" label="Trash" active={current === 'trash'} />
      </ul>

      <h2 className="rail-heading">Folders</h2>
      {top.length === 0 ? (
        <p className="rail-empty">No folders yet.</p>
      ) : (
        <ul className="rail-list">
          {top.map((folder) => (
            <li key={folder.id}>
              <RailLink
                href={`/?folder=${folder.id}`}
                label={folder.name}
                count={folder.documentCount}
                active={current === folder.id}
                bare
              />
              {childrenOf(folder.id).length > 0 ? (
                <ul className="rail-list rail-nested">
                  {childrenOf(folder.id).map((child) => (
                    <RailLink
                      key={child.id}
                      href={`/?folder=${child.id}`}
                      label={child.name}
                      count={child.documentCount}
                      active={current === child.id}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="rail-person">
        <Avatar userId={user.id} name={user.name} />
        <span className="rail-person-text">
          <span className="rail-person-name">{user.name}</span>
          <span className="rail-person-email">{user.email}</span>
        </span>
        <form action={signOutAction}>
          <button className="button button-quiet" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}

function RailLink({
  href,
  label,
  count,
  active,
  bare = false,
}: {
  readonly href: string;
  readonly label: string;
  readonly count?: number;
  readonly active: boolean;
  readonly bare?: boolean;
}) {
  const link = (
    <Link className="rail-link" href={href} aria-current={active ? 'page' : undefined}>
      <span>{label}</span>
      {count === undefined ? null : (
        <span className="rail-count">
          {count}
          <span className="sr-only"> documents</span>
        </span>
      )}
    </Link>
  );
  return bare ? link : <li>{link}</li>;
}
