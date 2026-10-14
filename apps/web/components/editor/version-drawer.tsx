'use client';

import { relativeTime, type Diff, type VersionSummary } from '@docs/shared';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import {
  createVersionAction,
  diffAction,
  listVersionsAction,
  versionStateAction,
} from '../../app/(app)/actions';
import { formatBytes } from '../../lib/bytes';
import type { EditorHandle } from './types';

interface VersionDrawerProps {
  readonly documentId: string;
  readonly shareToken: string | null;
  readonly canCreate: boolean;
  readonly canRestore: boolean;
  readonly handle: EditorHandle | null;
  readonly onCompare: (comparison: { readonly n: number; readonly diff: Diff } | null) => void;
  readonly onClose: () => void;
}

/**
 * Version history (docs/SPECS.md 5, docs/DESIGN.md 3.3).
 *
 * Three honest sentences live in this component, each a design decision rather
 * than copy: a version says who CUT it, never who wrote it (there is no
 * per-character authorship with garbage collection on, SPECS 5.3); a labelled
 * version says it is never pruned (SPECS 5.1); and restoring says, before it
 * happens, that an edit made during the restore is lost (SPECS 5.2).
 */
export function VersionDrawer({
  documentId,
  shareToken,
  canCreate,
  canRestore,
  handle,
  onCompare,
  onClose,
}: VersionDrawerProps) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [pending, startTransition] = useTransition();
  const heading = useRef<HTMLHeadingElement>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const now = Date.now();

  const load = useCallback(() => {
    startTransition(async () => {
      const result = await listVersionsAction(documentId, shareToken);
      if (result.ok) setVersions(result.value);
      else setError(result.message);
    });
  }, [documentId, shareToken]);

  useEffect(() => {
    load();
    heading.current?.focus();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !confirm.current?.open) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const compare = (n: number) => {
    setSelected(n);
    setError(null);
    startTransition(async () => {
      const result = await diffAction(documentId, n, shareToken);
      if (result.ok) onCompare({ n, diff: result.value });
      else setError(result.message);
    });
  };

  const restore = () => {
    if (selected === null || handle === null) return;
    const n = selected;
    startTransition(async () => {
      const result = await versionStateAction(documentId, n, shareToken);
      confirm.current?.close();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      handle.restoreFrom(result.value.state);
      onCompare(null);
      setSelected(null);
    });
  };

  const save = () => {
    startTransition(async () => {
      const result = await createVersionAction(documentId, label);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setLabel('');
      load();
    });
  };

  return (
    <aside className="drawer" aria-labelledby="versions-heading">
      <div className="drawer-head">
        <h2 id="versions-heading" className="drawer-title" tabIndex={-1} ref={heading}>
          Version history
        </h2>
        <button type="button" className="button button-quiet" onClick={onClose}>
          Close
        </button>
      </div>

      {canCreate ? (
        <form
          className="drawer-save"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="field">
            <span className="field-label">Save a version</span>
            <input
              className="field-input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Name this version"
              maxLength={80}
              required
            />
          </label>
          <button className="button button-primary" type="submit" disabled={pending}>
            Save
          </button>
        </form>
      ) : null}

      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {versions === null ? (
        <p className="muted" aria-busy="true">
          Loading versions
        </p>
      ) : versions.length === 0 ? (
        <p className="empty">
          No versions yet. One is saved automatically every few minutes while the document changes.
        </p>
      ) : (
        <ol className="versions">
          {versions.map((version) => (
            <li
              key={version.id}
              className="version"
              aria-current={selected === version.n ? 'true' : undefined}
            >
              <button type="button" className="version-button" onClick={() => compare(version.n)}>
                <span className="version-n mono">v{version.n}</span>
                <span className="version-when">
                  <time dateTime={version.createdAt}>
                    {relativeTime(new Date(version.createdAt), now)}
                  </time>
                </span>
                <span className="version-label">
                  {version.kind === 'MANUAL' && version.label ? (
                    <>
                      {version.label}
                      <span className="version-kept"> · Labelled, never pruned</span>
                    </>
                  ) : (
                    'Automatic'
                  )}
                </span>
                <span className="version-meta">
                  {version.authorName ? `Cut by ${version.authorName}` : 'Cut automatically'} ·{' '}
                  <span className="mono">{formatBytes(version.bytes)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {selected !== null && canRestore ? (
        <div className="drawer-foot">
          <button
            type="button"
            className="button button-primary"
            disabled={handle === null || pending}
            onClick={() => confirm.current?.showModal()}
          >
            Restore v{selected}
          </button>
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              setSelected(null);
              onCompare(null);
            }}
          >
            Back to the document
          </button>
        </div>
      ) : null}

      <dialog className="dialog" ref={confirm} aria-labelledby="restore-heading">
        <h2 id="restore-heading" className="dialog-title">
          Restore version {selected}?
        </h2>
        <p>
          Restoring replaces the whole document. An edit somebody makes during the restore is inside
          the replaced range and will be lost. The restore itself becomes part of the history, so
          you can return to the version saved before it.
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="button button-quiet"
            onClick={() => confirm.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button-danger"
            onClick={restore}
            disabled={pending}
          >
            Restore
          </button>
        </div>
      </dialog>
    </aside>
  );
}
