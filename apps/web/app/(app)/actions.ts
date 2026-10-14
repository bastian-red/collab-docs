'use server';

/**
 * Every write the browser can ask for, as a server action.
 *
 * Each one reads the session itself rather than trusting an argument, mints a
 * fresh service token through `apiFetch`/`syncFetch`, and lets the API decide
 * whether the caller may do it. Hiding a button is presentation; the 403 or 404
 * from the API is the rule (docs/SPECS.md 4.6). A typed `ApiError` comes back to
 * the caller as `{ ok: false, message }` so a dialog can show it in place, and
 * anything unexpected is thrown so it reaches the error boundary and the log.
 */
import {
  createVersionSchema,
  diffSchema,
  documentDetailSchema,
  documentMemberSchema,
  documentPath,
  documentSummarySchema,
  idSchema,
  shareLinkViewSchema,
  shareRoleSchema,
  roleSchema,
  versionStateSchema,
  versionSummarySchema,
  type DocumentMember,
  type Diff,
  type SessionUser,
  type ShareLinkView,
  type VersionState,
  type VersionSummary,
} from '@docs/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { auth, signOut } from '../../auth';
import { ApiError, apiFetch, query, syncFetch } from '../../lib/api';

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

async function currentUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  return session.user;
}

/** Turn a typed refusal into a message a dialog can render, and rethrow everything else. */
async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof ApiError && error.status < 500)
      return { ok: false, message: error.message };
    throw error;
  }
}

const id = (value: unknown): string => idSchema.parse(value);
const share = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value) ? value : null;

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/sign-in' });
}

export async function createDocumentAction(form: FormData): Promise<void> {
  const user = await currentUser();
  const folder = form.get('folderId');
  const created = await apiFetch(user, '/documents', documentDetailSchema, {
    method: 'POST',
    body: {
      title: 'Untitled document',
      folderId: typeof folder === 'string' && folder !== '' ? id(folder) : null,
    },
  });
  redirect(documentPath(created.id));
}

export async function restoreDocumentAction(form: FormData): Promise<void> {
  const user = await currentUser();
  await apiFetch(user, `/documents/${id(form.get('documentId'))}/restore`, documentSummarySchema, {
    method: 'POST',
  });
  revalidatePath('/');
}

export async function trashDocumentAction(form: FormData): Promise<void> {
  const user = await currentUser();
  await apiFetch(
    user,
    `/documents/${id(form.get('documentId'))}`,
    z.object({ deletedAt: z.string() }),
    {
      method: 'DELETE',
    },
  );
  redirect('/?view=trash');
}

export async function renameDocumentAction(
  documentId: string,
  title: string,
): Promise<Result<string>> {
  const user = await currentUser();
  return attempt(async () => {
    const renamed = await apiFetch(user, `/documents/${id(documentId)}`, documentSummarySchema, {
      method: 'PATCH',
      body: { title },
    });
    revalidatePath(documentPath(renamed.id));
    return renamed.title;
  });
}

export async function listVersionsAction(
  documentId: string,
  shareToken: string | null,
): Promise<Result<VersionSummary[]>> {
  const user = await currentUser();
  return attempt(() =>
    apiFetch(
      user,
      `/documents/${id(documentId)}/versions${query({ share: share(shareToken) })}`,
      z.array(versionSummarySchema),
    ),
  );
}

export async function versionStateAction(
  documentId: string,
  n: number,
  shareToken: string | null,
): Promise<Result<VersionState>> {
  const user = await currentUser();
  return attempt(() =>
    apiFetch(
      user,
      `/documents/${id(documentId)}/versions/${String(z.number().int().positive().parse(n))}/state${query({ share: share(shareToken) })}`,
      versionStateSchema,
    ),
  );
}

/** Diff from version `from` to the live document. Served by `apps/sync`, which holds the CRDT. */
export async function diffAction(
  documentId: string,
  from: number,
  shareToken: string | null,
): Promise<Result<Diff>> {
  const user = await currentUser();
  return attempt(() =>
    syncFetch(
      user,
      `/documents/${id(documentId)}/diff${query({ from: String(z.number().int().positive().parse(from)), share: share(shareToken) })}`,
      diffSchema,
    ),
  );
}

/** A labelled version, cut by `apps/sync` from the checkpoint plus its un-compacted log (SPECS 5.4). */
export async function createVersionAction(
  documentId: string,
  label: string,
): Promise<Result<VersionSummary>> {
  const user = await currentUser();
  const body = createVersionSchema.safeParse({ label });
  if (!body.success || body.data.label === null)
    return { ok: false, message: 'Give the version a name.' };
  return attempt(() =>
    syncFetch(user, `/documents/${id(documentId)}/versions`, versionSummarySchema, {
      method: 'POST',
      body: body.data,
    }),
  );
}

export interface ShareState {
  readonly members: DocumentMember[];
  readonly links: ShareLinkView[] | null;
}

/** Everything the share dialog shows. Links are `null` for a role that may not read them. */
export async function shareStateAction(
  documentId: string,
  canReadLinks: boolean,
): Promise<Result<ShareState>> {
  const user = await currentUser();
  return attempt(async () => {
    const [members, links] = await Promise.all([
      apiFetch(user, `/documents/${id(documentId)}/members`, z.array(documentMemberSchema)),
      canReadLinks
        ? apiFetch(user, `/documents/${id(documentId)}/links`, z.array(shareLinkViewSchema))
        : Promise.resolve(null),
    ]);
    return { members, links };
  });
}

export async function inviteMemberAction(
  documentId: string,
  email: string,
  role: string,
): Promise<Result<DocumentMember>> {
  const user = await currentUser();
  const parsedRole = shareRoleSchema.safeParse(role);
  if (!parsedRole.success) return { ok: false, message: 'Choose a role.' };
  return attempt(() =>
    apiFetch(user, `/documents/${id(documentId)}/members`, documentMemberSchema, {
      method: 'POST',
      body: { email, role: parsedRole.data },
    }),
  );
}

export async function setMemberRoleAction(
  documentId: string,
  userId: string,
  role: string,
): Promise<Result<DocumentMember[]>> {
  const user = await currentUser();
  const parsedRole = roleSchema.safeParse(role);
  if (!parsedRole.success) return { ok: false, message: 'Choose a role.' };
  return attempt(() =>
    apiFetch(user, `/documents/${id(documentId)}/members`, z.array(documentMemberSchema), {
      method: 'PUT',
      body: { userId: id(userId), role: parsedRole.data },
    }),
  );
}

export async function removeMemberAction(
  documentId: string,
  userId: string,
): Promise<Result<string>> {
  const user = await currentUser();
  return attempt(async () => {
    const removed = await apiFetch(
      user,
      `/documents/${id(documentId)}/members/${id(userId)}`,
      z.object({ userId: z.string() }),
      { method: 'DELETE' },
    );
    return removed.userId;
  });
}

export async function createLinkAction(
  documentId: string,
  role: string,
): Promise<Result<ShareLinkView>> {
  const user = await currentUser();
  const parsedRole = shareRoleSchema.safeParse(role);
  if (!parsedRole.success) return { ok: false, message: 'Choose a role.' };
  return attempt(() =>
    apiFetch(user, `/documents/${id(documentId)}/links`, shareLinkViewSchema, {
      method: 'POST',
      body: { role: parsedRole.data },
    }),
  );
}

export async function revokeLinkAction(
  documentId: string,
  linkId: string,
): Promise<Result<ShareLinkView>> {
  const user = await currentUser();
  return attempt(() =>
    apiFetch(user, `/documents/${id(documentId)}/links/${id(linkId)}/revoke`, shareLinkViewSchema, {
      method: 'POST',
    }),
  );
}
