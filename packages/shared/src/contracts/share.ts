import { z } from 'zod';

import { emailSchema, idSchema, instantSchema, roleSchema, shareRoleSchema } from './primitives';

export const shareLinkSchema = z.object({
  id: idSchema,
  /**
   * Returned only to somebody who may already read the link list, and never
   * logged. It is the credential.
   */
  token: z.string().min(16),
  role: shareRoleSchema,
  expiresAt: instantSchema.nullable(),
  revokedAt: instantSchema.nullable(),
  createdAt: instantSchema,
});

export const createShareLinkSchema = z.object({
  role: shareRoleSchema,
  /**
   * Hours from now.
   *
   * Three states, and they are three on purpose:
   *
   * - **absent** -- use the server's `SHARE_LINK_TTL_HOURS`. This is what the
   *   dialog sends when nobody touched the expiry field, and it is why the
   *   default lives in the environment rather than in this file: changing the
   *   house policy must not mean shipping a new client bundle.
   * - **`null`** -- never expires. The UI does not offer it, so saying it takes
   *   a deliberate request rather than an omitted field. A link that outlives
   *   everyone's memory of making it is the failure mode being made hard to
   *   reach by accident.
   * - **a number** -- exactly that many hours, capped at a year.
   */
  ttlHours: z.number().int().positive().max(8760).nullable().optional(),
});

export const setMemberRoleSchema = z.object({
  userId: idSchema,
  role: roleSchema,
});

/**
 * Add somebody to a document, by the address they signed up with.
 *
 * By email and not by id, because an id is not something one person knows about
 * another. The API answers the same `NOT_FOUND` whether the address has no
 * account or the caller simply mistyped it, so this endpoint is not a way to ask
 * "does this person have an account here".
 *
 * `shareRoleSchema`, so OWNER is unreachable: transferring a document is
 * `setMemberRoleSchema`, a deliberate and separate act, and it demotes the
 * current owner in the same transaction.
 */
export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: shareRoleSchema,
});

/** What a share token resolves to for a signed-in caller who presents it. */
export const resolvedShareSchema = z.object({
  documentId: idSchema,
  role: shareRoleSchema,
  expiresAt: instantSchema.nullable(),
});

/**
 * A share link as the owner's dialog receives it: the row plus the absolute URL
 * the API built with `shareLinkUrl`, so the web app never assembles one itself and
 * the `?share=` spelling lives in exactly one function.
 */
export const shareLinkViewSchema = shareLinkSchema.extend({ url: z.string().url() });

export type ShareLink = z.infer<typeof shareLinkSchema>;
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type ResolvedShare = z.infer<typeof resolvedShareSchema>;
export type ShareLinkView = z.infer<typeof shareLinkViewSchema>;
