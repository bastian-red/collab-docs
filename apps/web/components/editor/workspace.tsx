'use client';

import { relativeTime, type DocumentDetail, type Diff, type SessionUser } from '@docs/shared';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { renameDocumentAction, trashDocumentAction } from '../../app/(app)/actions';
import { formatBytes } from '../../lib/bytes';
import { DiffView } from './diff-view';
import { ParticipantStack } from './participant-stack';
import { ShareDialog } from './share-dialog';
import { SyncPill } from './sync-pill';
import { syncState, type ProviderSignals } from './sync-state';
import type { EditorHandle, Participant } from './types';
import { VersionDrawer } from './version-drawer';

/**
 * The CRDT island, client-only. Everything that imports Yjs lives behind this
 * dynamic import, so the server bundle never evaluates it (docs/CODESTYLE.md 17).
 * The loading state is the page skeleton from docs/DESIGN.md 5.2.
 */
const EditorSurface = dynamic(() => import('./editor-surface'), {
  ssr: false,
  loading: () => (
    // role="status", not a bare div with aria-label: a generic element may not
    // carry a name (axe aria-prohibited-attr), and Firefox's axe run caught it in
    // the moment before the editor mounted.
    <div className="skeleton" role="status" aria-busy="true">
      <span className="sr-only">Loading the document</span>
      <span className="skeleton-line" />
      <span className="skeleton-line" />
      <span className="skeleton-line skeleton-short" />
    </div>
  ),
});

export interface WorkspacePermissions {
  readonly write: boolean;
  readonly rename: boolean;
  readonly delete: boolean;
  readonly readVersions: boolean;
  readonly createVersion: boolean;
  readonly restoreVersion: boolean;
  readonly readMembers: boolean;
  readonly writeMembers: boolean;
  readonly readLinks: boolean;
  readonly writeLinks: boolean;
}

interface WorkspaceProps {
  readonly detail: DocumentDetail;
  readonly user: SessionUser;
  readonly shareToken: string | null;
  readonly syncUrl: string;
  readonly maxBytes: number;
  readonly permissions: WorkspacePermissions;
}

/**
 * The editor screen (docs/DESIGN.md 3.1): top bar, toolbar slot, the page.
 *
 * Rendered on the server like any client component, so the `<h1>`, the metadata
 * line and the top bar are in the first HTML response. Only the editor body waits
 * for the socket. `permissions` decide what is SHOWN; the API and the sync server
 * decide what is ALLOWED, so a crafted request from a hidden button is refused
 * there regardless (docs/SPECS.md 4.2, 4.6).
 */
export function Workspace({
  detail,
  user,
  shareToken,
  syncUrl,
  maxBytes,
  permissions,
}: WorkspaceProps) {
  const [signals, setSignals] = useState<ProviderSignals>({
    socket: 'connecting',
    synced: false,
    unsyncedChanges: 0,
    refusal: null,
  });
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const [panel, setPanel] = useState<'none' | 'versions' | 'share'>('none');
  const [comparison, setComparison] = useState<{ readonly n: number; readonly diff: Diff } | null>(
    null,
  );
  const [title, setTitle] = useState(detail.title);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  const historyButton = useRef<HTMLButtonElement>(null);

  const state = syncState(signals);
  const editable = permissions.write && signals.refusal === null;

  // Ctrl/Cmd+Alt+H opens history (docs/DESIGN.md 6).
  useEffect(() => {
    if (!permissions.readVersions) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'h') {
        event.preventDefault();
        setPanel('versions');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [permissions.readVersions]);

  const closePanel = useCallback(() => {
    setPanel('none');
    setComparison(null);
    // Focus returns to what opened the drawer, so a keyboard user is not dropped
    // at the top of the document.
    historyButton.current?.focus();
  }, []);

  const refusalText =
    signals.refusal === null
      ? null
      : /large|TOO_LARGE/iu.test(signals.refusal)
        ? `This document has reached its size limit (${formatBytes(maxBytes)}). New changes are not being saved.`
        : 'The server stopped accepting changes from this window. You may have lost access, or the document was deleted. Reload to check.';

  return (
    <div className="workspace">
      <header className="topbar">
        <Link className="brand" href="/">
          collab-docs
        </Link>
        <nav className="crumbs" aria-label="Breadcrumb">
          <ol>
            <li>
              <Link href="/">Documents</Link>
            </li>
            {detail.folderName ? (
              <li>
                <Link href={`/?folder=${detail.folderId ?? ''}`}>{detail.folderName}</Link>
              </li>
            ) : null}
          </ol>
        </nav>
        <div className="topbar-actions">
          <SyncPill state={state} detail={refusalText} />
          <ParticipantStack participants={participants} />
          {permissions.readVersions ? (
            <button
              ref={historyButton}
              type="button"
              className="button button-quiet"
              aria-expanded={panel === 'versions'}
              aria-keyshortcuts="Control+Alt+H"
              onClick={() => (panel === 'versions' ? closePanel() : setPanel('versions'))}
            >
              History
            </button>
          ) : null}
          {permissions.readMembers ? (
            <button
              type="button"
              className="button button-primary"
              onClick={() => setPanel('share')}
            >
              Share
            </button>
          ) : null}
        </div>
      </header>

      <div className="toolbar-row" ref={setToolbarSlot} />

      {!permissions.write ? (
        <p className="banner" role="note">
          Viewing only. You can read and follow along; changes are made by editors.
        </p>
      ) : null}
      {refusalText !== null ? (
        <p className="banner banner-danger" role="alert">
          <span aria-hidden="true">⚠ </span>
          {refusalText}
        </p>
      ) : null}

      <div className="desk">
        {comparison !== null ? (
          <div className="page page-diff">
            <DiffView n={comparison.n} diff={comparison.diff} />
          </div>
        ) : null}
        <main id="main" className="page" hidden={comparison !== null}>
          <p className="page-meta mono">
            <span>doc_{detail.id.slice(-6)}</span> · <span>{formatBytes(detail.stateBytes)}</span> ·{' '}
            <span>seq {String(detail.nextSeq - 1n)}</span>
          </p>
          <TitleHeading
            documentId={detail.id}
            title={title}
            canRename={permissions.rename}
            onRenamed={setTitle}
          />
          <p className="page-byline">
            Last changed{' '}
            <time dateTime={detail.updatedAt} suppressHydrationWarning>
              {relativeTime(new Date(detail.updatedAt), Date.now())}
            </time>
          </p>
          <EditorSurface
            documentId={detail.id}
            title={title}
            shareToken={shareToken}
            syncUrl={syncUrl}
            user={{ id: user.id, name: user.name }}
            editable={editable}
            onSignals={setSignals}
            onParticipants={setParticipants}
            onReady={setHandle}
            toolbarSlot={toolbarSlot}
          />
          {permissions.delete ? (
            <form className="page-foot" action={trashDocumentAction}>
              <input type="hidden" name="documentId" value={detail.id} />
              <button type="submit" className="button button-danger-quiet">
                Move to trash
              </button>
            </form>
          ) : null}
        </main>
        {panel === 'versions' ? (
          <VersionDrawer
            documentId={detail.id}
            shareToken={shareToken}
            canCreate={permissions.createVersion && editable}
            canRestore={permissions.restoreVersion && editable}
            handle={handle}
            onCompare={setComparison}
            onClose={closePanel}
          />
        ) : null}
      </div>

      {panel === 'share' ? (
        <ShareDialog
          documentId={detail.id}
          title={title}
          selfId={user.id}
          canWriteMembers={permissions.writeMembers}
          canReadLinks={permissions.readLinks}
          canWriteLinks={permissions.writeLinks}
          onClose={() => setPanel('none')}
        />
      ) : null}
    </div>
  );
}

/**
 * The title is the page's `<h1>`, and for an editor it is also editable: a button
 * that swaps to an input, so the heading stays a heading for everybody who cannot
 * rename and a screen reader never meets an `<h1>` that is a text field.
 */
function TitleHeading({
  documentId,
  title,
  canRename,
  onRenamed,
}: {
  readonly documentId: string;
  readonly title: string;
  readonly canRename: boolean;
  readonly onRenamed: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!editing || !canRename) {
    return (
      <div className="title-row">
        <h1 className="doc-heading">{title}</h1>
        {canRename ? (
          <button
            type="button"
            className="button button-quiet title-rename"
            onClick={() => setEditing(true)}
          >
            Rename<span className="sr-only"> {title}</span>
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="title-row"
      onSubmit={(event) => {
        event.preventDefault();
        const next = String(new FormData(event.currentTarget).get('title') ?? '').trim();
        startTransition(async () => {
          const result = await renameDocumentAction(documentId, next);
          if (!result.ok) {
            setError(result.message);
            return;
          }
          onRenamed(result.value);
          setEditing(false);
          setError(null);
        });
      }}
    >
      <h1 className="sr-only">{title}</h1>
      <label className="sr-only" htmlFor="title-input">
        Document title
      </label>
      <input
        id="title-input"
        className="field-input title-input"
        name="title"
        defaultValue={title}
        maxLength={200}
        required
        autoFocus
        onKeyDown={(event) => {
          if (event.key === 'Escape') setEditing(false);
        }}
      />
      <button className="button button-primary" type="submit" disabled={pending}>
        Save
      </button>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
