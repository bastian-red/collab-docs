/**
 * Who may open a socket, and who may write through it.
 *
 * This is the security boundary of the whole application, so it is one file with
 * one exported decision function and a thin Hocuspocus adapter around it. The
 * decision takes plain data and returns plain data, which is what makes it
 * testable without a websocket. See docs/SPECS.md sections 4.1 and 4.2.
 */
import { resolveAccess, type ShareLinkRow } from '@docs/doc-access';
import {
  DomainError,
  can,
  idSchema,
  mayWriteDocument,
  type Action,
  type Role,
  type SessionUser,
} from '@docs/shared';
import { verifyServiceToken, type VerifyFailure } from '@docs/shared/server';

/** What the handshake needs to look up, expressed so the caller owns the queries. */
export interface AccessLookup {
  membership(documentId: string, userId: string): Promise<Role | null>;
  shareLink(token: string): Promise<ShareLinkRow | null>;
  documentExists(documentId: string): Promise<boolean>;
}

export interface HandshakeInput {
  readonly token: string;
  readonly documentId: string;
  /** The `share` query parameter on the websocket URL, if the client presented one. */
  readonly shareToken: string | null;
  readonly now: Date;
}

export interface HandshakeContext {
  readonly user: SessionUser;
  readonly role: Role;
  readonly documentId: string;
}

export interface HandshakeResult {
  readonly context: HandshakeContext;
  /** Set straight onto `connectionConfig.readOnly`. */
  readonly readOnly: boolean;
}

/**
 * Why a handshake was refused.
 *
 * Kept as a value so the caller can LOG it, and deliberately not put on the
 * wire. Telling a caller "expired signature" rather than "not authorised" tells
 * them the token was real and the secret is right, which is the one bit somebody
 * probing has no other way to learn. docs/SPECS.md 4.1 step 5.
 */
export type RefusalReason = VerifyFailure | 'no-access' | 'no-document';

export class HandshakeRefused extends Error {
  constructor(readonly reason: RefusalReason) {
    // One message for every reason, on purpose. The reason travels in the
    // property, which goes to the log; the message is what a client could see.
    super('Not authorised for this document');
    this.name = 'HandshakeRefused';
    Object.setPrototypeOf(this, HandshakeRefused.prototype);
  }
}

/**
 * The whole decision.
 *
 * Order matters and is not arbitrary: the token is verified before anything is
 * looked up, so an unauthenticated caller cannot use response timing to learn
 * whether a document id exists.
 */
export async function authoriseHandshake(
  input: HandshakeInput,
  secret: string,
  lookup: AccessLookup,
): Promise<HandshakeResult> {
  const verified = verifyServiceToken(input.token, secret);
  if (!verified.ok) throw new HandshakeRefused(verified.reason);

  const [exists, membership, shareLink] = await Promise.all([
    lookup.documentExists(input.documentId),
    lookup.membership(input.documentId, verified.user.id),
    input.shareToken === null || input.shareToken === ''
      ? Promise.resolve(null)
      : lookup.shareLink(input.shareToken),
  ]);

  // Checked BEFORE the role, and independently of it. `document_members` rows
  // outlive a soft delete -- nothing cleans them up, and cleaning them up would
  // make an undelete lose everybody's access -- so an owner still has a role on
  // a document that has been deleted. Deciding on the role alone let the owner
  // of a deleted document open it, sync it, and (from an offline copy) write it
  // back into existence. `documentExists` is the one that reads
  // `deleted_at IS NULL`.
  if (!exists) throw new HandshakeRefused('no-document');

  const outcome = resolveAccess(
    input.documentId,
    { membership, shareLink, presentedToken: input.shareToken },
    input.now,
  );

  if (!outcome.ok) throw new HandshakeRefused('no-access');

  return {
    context: { user: verified.user, role: outcome.access.role, documentId: input.documentId },
    // The one line the read-only guarantee rests on. Hocuspocus drops the writes
    // itself once this is set (SPECS 4.2); what we own is the decision, and it is
    // this expression.
    readOnly: !mayWriteDocument(outcome.access.role),
  };
}

/**
 * The same decision, for an HTTP request rather than a socket.
 *
 * `/documents/:id/diff` and `POST /documents/:id/versions` live on this server
 * because both need a `Y.Doc` (docs/CODESTYLE.md section 9), and both read or
 * write a document. Reusing `authoriseHandshake` rather than writing a second
 * check is the point: an HTTP route with its own idea of who may read a document
 * is a second enforcement point, and the weaker of two is the one an attacker
 * gets to choose.
 *
 * The extra step is the ACTION. A socket asks one question -- may this connection
 * write -- and Hocuspocus enforces the answer. An HTTP route asks a specific one,
 * so the matrix is consulted here.
 */
export async function authoriseDocumentRequest(
  input: HandshakeInput,
  secret: string,
  lookup: AccessLookup,
  action: Action,
): Promise<HandshakeContext> {
  let result: HandshakeResult;
  try {
    result = await authoriseHandshake(input, secret, lookup);
  } catch (error) {
    // A `HandshakeRefused` is a socket-level refusal: it carries a reason and no
    // status, because a socket refusal is a close. Over HTTP it has to become a
    // code, and the mapping is the same anti-enumeration argument
    // `services/doc-access` makes:
    //
    //   - A bad token is 401. The caller has proved nothing, and the fix is to
    //     get a new one.
    //   - No role, or a document that is not there, are BOTH 404. A caller who
    //     is not on a document must not be able to tell one that exists from one
    //     that does not; "403 here, 404 there" is a directory listing.
    //
    // The reason itself stays in the log, where `onAuthenticate` already puts
    // it. Telling a caller "expired signature" rather than "not authorised"
    // tells them the token was real and the secret is right.
    if (error instanceof HandshakeRefused) {
      console.warn(`[sync] request refused for ${input.documentId}: ${error.reason}`);
      throw error.reason === 'no-access' || error.reason === 'no-document'
        ? new DomainError('NOT_FOUND', 'Document not found')
        : new DomainError('UNAUTHENTICATED', 'That token was not accepted');
    }
    throw error;
  }

  if (!can(result.context.role, action)) {
    // FORBIDDEN and not the handshake's blanket refusal: this caller has already
    // been told the document exists, because they can read it. Answering
    // "not found" to an editor about a document open on their screen files a bug.
    throw new DomainError('FORBIDDEN', `Your role on this document cannot ${action}`);
  }
  return result.context;
}

/**
 * The share token comes off the URL, not out of the JWT.
 *
 * A separate parameter because the two have different lifetimes and different
 * holders: the JWT says who you are and expires in two minutes, the link says
 * what you were given and lives until it is revoked. Folding one into the other
 * would mean reissuing every session token when a link is revoked.
 */
export function shareTokenFrom(parameters: URLSearchParams): string | null {
  const value = parameters.get('share');
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `documentName` is the document id and nothing else.
 *
 * Hocuspocus lets a client name any room it likes, so this is the point where an
 * arbitrary client-supplied string becomes a database key. A room name carrying
 * a path, a wildcard or a query string would be looked up verbatim -- harmless
 * against Prisma's parameterised queries, and not harmless in a log somebody
 * later greps, or in any cache keyed by it.
 *
 * Checked with `idSchema` from `@docs/shared`, the same parser every HTTP
 * contract uses, rather than a regex written here. A second definition of "what
 * an id looks like" is a second thing to keep in step, and the looser of the two
 * is the one an attacker gets to choose.
 */
export function documentIdFromRoom(documentName: string): string {
  const parsed = idSchema.safeParse(documentName);
  if (!parsed.success) {
    throw new DomainError('INVALID', 'That is not a document id');
  }
  return parsed.data;
}
