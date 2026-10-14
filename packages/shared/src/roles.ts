/**
 * The permission matrix, frozen, in one place.
 *
 * Three enforcement points read it and none of them re-states it: the API's
 * guards, the sync server's `onAuthenticate`, and the web app's rendering. The
 * third is a convenience -- hiding a button the server would refuse anyway --
 * and is never the enforcement. See docs/SPECS.md section 4.2.
 */

/** Strongest first. The order is the comparison in `atLeast`. */
export const ROLES = ['OWNER', 'EDITOR', 'COMMENTER', 'VIEWER'] as const;

export type Role = (typeof ROLES)[number];

/**
 * The roles a share link may carry: every role except OWNER.
 *
 * Derived by filtering `ROLES` rather than written out, so adding a role adds it
 * here too and the omission of OWNER stays the only deliberate exclusion. A link
 * is forwardable, and a forwardable link that hands away the document is not a
 * sharing feature, it is a way to lose one. Enforced three times: here, in
 * `services/doc-access`, and by `CHECK (role <> 'OWNER')` in the database.
 */
export const SHARE_ROLES = ROLES.filter(
  (role): role is Exclude<Role, 'OWNER'> => role !== 'OWNER',
) as [Exclude<Role, 'OWNER'>, ...Exclude<Role, 'OWNER'>[]];

export type ShareableRole = (typeof SHARE_ROLES)[number];

export const ACTIONS = [
  'document.read',
  'document.write',
  'document.rename',
  'document.move',
  'document.delete',
  'version.read',
  'version.create',
  'version.restore',
  'member.read',
  'member.write',
  'link.read',
  'link.write',
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * Deliberately written out in full rather than derived from a rank, even though
 * today it happens to be monotonic in seniority. A derived matrix cannot express
 * "a COMMENTER may read versions but never restore one", and the first exception
 * to the rank is the one that would be got wrong.
 */
const MATRIX: Readonly<Record<Role, ReadonlySet<Action>>> = Object.freeze({
  OWNER: new Set<Action>([
    'document.read',
    'document.write',
    'document.rename',
    'document.move',
    'document.delete',
    'version.read',
    'version.create',
    'version.restore',
    'member.read',
    'member.write',
    'link.read',
    'link.write',
  ]),
  EDITOR: new Set<Action>([
    'document.read',
    'document.write',
    'document.rename',
    'version.read',
    'version.create',
    'version.restore',
    'member.read',
    'link.read',
  ]),
  COMMENTER: new Set<Action>(['document.read', 'version.read', 'member.read']),
  VIEWER: new Set<Action>(['document.read']),
});

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].has(action);
}

/** True when `role` is `floor` or stronger. */
export function atLeast(role: Role, floor: Role): boolean {
  return ROLES.indexOf(role) <= ROLES.indexOf(floor);
}

/**
 * Whether a connection holding this role may write to the CRDT stream.
 *
 * This is the single question `onAuthenticate` asks, and the answer sets
 * `connectionConfig.readOnly`. It is a named function rather than an inline
 * `can(role, 'document.write')` because it is the security boundary of the
 * whole application and it should be greppable.
 */
export function mayWriteDocument(role: Role): boolean {
  return can(role, 'document.write');
}

/**
 * The strongest of two roles.
 *
 * A person can reach a document twice: as a direct member and through a share
 * link. Taking the stronger of the two is the only answer that does not
 * surprise somebody -- an editor who opens a view-only link is still an editor,
 * and demoting them because of how they arrived would look like data loss.
 */
export function strongest(a: Role, b: Role): Role {
  return atLeast(a, b) ? a : b;
}
