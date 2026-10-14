import 'server-only';

import type { SessionUser } from '@docs/shared';
import { redirect } from 'next/navigation';

import { auth } from '../auth';

/**
 * The signed-in user, or a redirect to sign in that comes back to `next`.
 *
 * Per page, not in a layout: a layout does not know the URL it is rendering, and
 * the share-link flow depends on returning to the exact path AND query a reader
 * arrived on. `next` is re-validated by `safeNextPath` on the way back, so passing
 * it through here is not an open redirect.
 *
 * This is the authorisation boundary for the browser only. Every API call carries
 * its own service token, so a reader who skipped this would get a 401 from the API
 * rather than somebody else's document.
 */
export async function requireUser(next: string): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return session.user;
}
