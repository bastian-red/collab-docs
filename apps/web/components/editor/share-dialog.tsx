'use client';

import {
  SHARE_ROLES,
  absoluteDay,
  type DocumentMember,
  type Role,
  type ShareLinkView,
} from '@docs/shared';
import { useEffect, useRef, useState, useTransition } from 'react';

import {
  createLinkAction,
  inviteMemberAction,
  removeMemberAction,
  revokeLinkAction,
  setMemberRoleAction,
  shareStateAction,
} from '../../app/(app)/actions';

const ROLE_WORD: Readonly<Record<Role, string>> = {
  OWNER: 'Owner',
  EDITOR: 'Editor',
  COMMENTER: 'Commenter',
  VIEWER: 'Viewer',
};

interface ShareDialogProps {
  readonly documentId: string;
  readonly title: string;
  readonly selfId: string;
  readonly canWriteMembers: boolean;
  readonly canReadLinks: boolean;
  readonly canWriteLinks: boolean;
  readonly onClose: () => void;
}

/**
 * The share dialog (docs/DESIGN.md 3.4).
 *
 * A native `<dialog>` opened with `showModal()`: focus is trapped and Esc closes
 * it with no script of ours, and the browser returns focus to the opener. Every
 * control is shown only to a role that may use it, and every action is still
 * re-checked by the API; the footer sentence says where read-only is actually
 * enforced, because "hidden in the editor" is the lie this project exists to avoid.
 */
export function ShareDialog({
  documentId,
  title,
  selfId,
  canWriteMembers,
  canReadLinks,
  canWriteLinks,
  onClose,
}: ShareDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [members, setMembers] = useState<DocumentMember[] | null>(null);
  const [links, setLinks] = useState<ShareLinkView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    dialog.current?.showModal();
    startTransition(async () => {
      const result = await shareStateAction(documentId, canReadLinks);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setMembers(result.value.members);
      setLinks(result.value.links);
    });
  }, [documentId, canReadLinks]);

  const run = <T,>(
    work: () => Promise<{ ok: true; value: T } | { ok: false; message: string }>,
    apply: (value: T) => void,
  ) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (result.ok) apply(result.value);
      else setError(result.message);
    });
  };

  const live = links?.filter((link) => link.revokedAt === null) ?? [];

  return (
    <dialog
      className="dialog dialog-share"
      ref={dialog}
      aria-labelledby="share-heading"
      onClose={onClose}
    >
      <h2 id="share-heading" className="dialog-title">
        Share this document
      </h2>
      <p className="dialog-sub">{title}</p>

      {canWriteMembers ? (
        <form
          className="share-invite"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const target = event.currentTarget;
            run(
              () =>
                inviteMemberAction(
                  documentId,
                  String(form.get('email') ?? ''),
                  String(form.get('role') ?? ''),
                ),
              (member) => {
                setMembers((current) => [
                  ...(current ?? []).filter((m) => m.id !== member.id),
                  member,
                ]);
                target.reset();
              },
            );
          }}
        >
          <label className="field share-email">
            <span className="field-label">Add people by email</span>
            <input className="field-input" name="email" type="email" required autoComplete="off" />
          </label>
          <label className="field">
            <span className="field-label">Role</span>
            <select className="field-input" name="role" defaultValue="EDITOR">
              {SHARE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_WORD[role]}
                </option>
              ))}
            </select>
          </label>
          <button className="button button-primary" type="submit" disabled={pending}>
            Invite
          </button>
        </form>
      ) : null}

      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <h3 className="share-heading">People with access</h3>
      {members === null ? (
        <p className="muted" aria-busy="true">
          Loading
        </p>
      ) : members.length <= 1 ? (
        <p className="muted">Only you have access.</p>
      ) : null}
      <ul className="share-people">
        {(members ?? []).map((member) => (
          <li key={member.id} className="share-person">
            <span className="share-person-name">
              {member.name}
              {member.id === selfId ? <span className="muted"> (you)</span> : null}
            </span>
            {canWriteMembers && member.role !== 'OWNER' ? (
              <>
                <label className="sr-only" htmlFor={`role-${member.id}`}>
                  Role for {member.name}
                </label>
                <select
                  id={`role-${member.id}`}
                  className="field-input share-role"
                  value={member.role}
                  onChange={(event) =>
                    run(
                      () => setMemberRoleAction(documentId, member.id, event.target.value),
                      setMembers,
                    )
                  }
                >
                  {SHARE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_WORD[role]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() =>
                    run(
                      () => removeMemberAction(documentId, member.id),
                      (removed) =>
                        setMembers((current) => (current ?? []).filter((m) => m.id !== removed)),
                    )
                  }
                >
                  Remove<span className="sr-only"> {member.name}</span>
                </button>
              </>
            ) : (
              <span className="share-role-word">{ROLE_WORD[member.role]}</span>
            )}
          </li>
        ))}
      </ul>

      {canReadLinks ? (
        <>
          <h3 className="share-heading">Anyone with the link</h3>
          {live.length === 0 ? <p className="muted">No active links.</p> : null}
          <ul className="share-links">
            {live.map((link) => (
              <li key={link.id} className="share-link">
                <span className="share-link-role">{ROLE_WORD[link.role]}</span>
                <label className="sr-only" htmlFor={`link-${link.id}`}>
                  Share link, {ROLE_WORD[link.role].toLowerCase()} access
                </label>
                <input
                  id={`link-${link.id}`}
                  className="field-input mono share-url"
                  readOnly
                  value={link.url}
                />
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link.url).then(() => setCopied(link.id));
                  }}
                >
                  {copied === link.id ? 'Copied' : 'Copy'}
                </button>
                <span className="share-link-expiry muted">
                  {link.expiresAt === null
                    ? 'Never expires'
                    : `Expires ${absoluteDay(new Date(link.expiresAt))}`}
                </span>
                {canWriteLinks ? (
                  <button
                    type="button"
                    className="button button-danger-quiet"
                    onClick={() =>
                      run(
                        () => revokeLinkAction(documentId, link.id),
                        (revoked) =>
                          setLinks((current) =>
                            (current ?? []).map((l) => (l.id === revoked.id ? revoked : l)),
                          ),
                      )
                    }
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {canWriteLinks ? (
            <form
              className="share-new-link"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                run(
                  () => createLinkAction(documentId, String(form.get('role') ?? 'VIEWER')),
                  (link) => setLinks((current) => [link, ...(current ?? [])]),
                );
              }}
            >
              <label className="field">
                <span className="field-label">New link gives</span>
                <select className="field-input" name="role" defaultValue="VIEWER">
                  {SHARE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_WORD[role]} access
                    </option>
                  ))}
                </select>
              </label>
              <button className="button button-quiet" type="submit" disabled={pending}>
                Create link
              </button>
            </form>
          ) : null}
        </>
      ) : null}

      <p className="dialog-note">
        A viewer&rsquo;s connection is opened read-only by the sync server. Edits from it are
        dropped before they reach the document, not hidden in the editor.
      </p>
      <div className="dialog-actions">
        <button
          type="button"
          className="button button-quiet"
          onClick={() => dialog.current?.close()}
        >
          Done
        </button>
      </div>
    </dialog>
  );
}
