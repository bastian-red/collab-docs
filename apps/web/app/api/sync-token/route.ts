/**
 * A fresh service token for the editor's websocket handshake.
 *
 * A route rather than a value rendered into the page: a token is a credential and
 * HTML is cached, screenshotted and stored, and a token lives 120 seconds, so one
 * baked into a page is stale before the first reconnect. `HocuspocusProvider` is
 * given the callback form of `token` and asks again on every connection attempt
 * (docs/SPECS.md 4.1).
 *
 * It mints for the **caller's own session** and takes no parameters. A route that
 * accepted a user id would hand anybody a token for anybody.
 */
import { NextResponse } from 'next/server';
import { SERVICE_TOKEN_TTL_SECONDS, mintServiceToken } from '@docs/shared/server';

import { auth } from '../../../auth';
import { authSecret } from '../../../lib/config';

// Never cached by any layer. A shared cache holding one person's token and
// handing it to the next caller is the worst outcome this route has.
const NO_STORE = { 'cache-control': 'no-store, private' } as const;

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  const user = session?.user;
  if (!user) {
    return NextResponse.json(
      { code: 'UNAUTHENTICATED', message: 'Not signed in.' },
      { status: 401, headers: NO_STORE },
    );
  }

  const token = mintServiceToken(user, authSecret());
  return NextResponse.json(
    { token, expiresInSeconds: SERVICE_TOKEN_TTL_SECONDS },
    { headers: NO_STORE },
  );
}
