import { SHARE_PARAM, can, documentDetailSchema, documentPath, idSchema } from '@docs/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Workspace } from '../../../../components/editor/workspace';
import { ApiError, apiFetch, query } from '../../../../lib/api';
import { documentMaxBytes, publicSyncUrl } from '../../../../lib/config';
import { requireUser } from '../../../../lib/session';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = { title: 'Document' };

/**
 * The editor route: the server renders the shell, the title and the metadata line,
 * and the client island takes over the body once the socket connects.
 *
 * `NOT_FOUND` from the API renders the 404 page, and that is also what a caller
 * with no access gets: the API answers "no access" as 404 so a stranger cannot
 * tell a real document from a missing one (docs/SPECS.md 4.5), and this page must
 * not undo that by rendering something different for the two.
 *
 * The share token rides along unchanged to the API read and, inside the island, to
 * the socket URL; the role it grants is whatever the API says it grants, never what
 * the URL claims.
 */
export default async function DocumentPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();

  const raw = (await searchParams)[SHARE_PARAM];
  const share = typeof raw === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(raw) ? raw : null;
  const user = await requireUser(`${documentPath(id)}${query({ [SHARE_PARAM]: share })}`);

  let detail;
  try {
    detail = await apiFetch(
      user,
      `/documents/${id}${query({ [SHARE_PARAM]: share })}`,
      documentDetailSchema,
    );
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'NOT_FOUND' || error.code === 'GONE'))
      notFound();
    throw error;
  }

  return (
    <Workspace
      detail={detail}
      user={user}
      shareToken={share}
      syncUrl={publicSyncUrl}
      maxBytes={documentMaxBytes}
      permissions={{
        write: can(detail.role, 'document.write'),
        rename: can(detail.role, 'document.rename'),
        delete: can(detail.role, 'document.delete'),
        readVersions: can(detail.role, 'version.read'),
        createVersion: can(detail.role, 'version.create'),
        restoreVersion: can(detail.role, 'version.restore'),
        readMembers: can(detail.role, 'member.read'),
        writeMembers: can(detail.role, 'member.write'),
        readLinks: can(detail.role, 'link.read'),
        writeLinks: can(detail.role, 'link.write'),
      }}
    />
  );
}
