import { z } from 'zod';

import { ROLES, SHARE_ROLES } from '../roles';

/**
 * The small shapes every other contract is built from.
 *
 * Everything here is a zod schema with its TypeScript type derived by `z.infer`.
 * Never a hand-written interface beside a schema: the two drift, and the one
 * that drifts is always the one that is not validated.
 */

/** A cuid, which is what every `@id @default(cuid())` in the schema produces. */
export const idSchema = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const nameSchema = z.string().trim().min(1).max(80);

/**
 * At least 12 characters. Not a composition rule -- no "one digit, one symbol" --
 * because those push people towards `Password1!` and measurably lower entropy.
 * Length is the property that matters.
 */
export const passwordSchema = z.string().min(12).max(200);

export const documentTitleSchema = z.string().trim().min(1).max(200);

/**
 * A version label. Trimmed and bounded, and empty means "no label" rather than
 * an empty string, so `label === null` is the single way to ask "was this cut by
 * a person?" alongside `kind`.
 */
export const versionLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

/**
 * Built FROM the matrix's own list rather than repeating it. Two parallel
 * literals would typecheck forever and drift the first time a role is added:
 * the API would reject a role the matrix happily answers for, or accept one it
 * has no row for.
 */
export const roleSchema = z.enum(ROLES);

/**
 * A role a share link may carry. OWNER is absent, and its absence is enforced
 * three times: here, in `services/doc-access`, and by
 * `CHECK (role <> 'OWNER')` in the database. A link is forwardable, and a
 * forwardable link that hands away the document is not a sharing feature.
 */
export const shareRoleSchema = z.enum(SHARE_ROLES);

export const versionKindSchema = z.enum(['AUTO', 'MANUAL']);

/**
 * `seq` and `n` are both integers and they are never interchangeable, so they
 * get separate names even though the runtime check is the same. `seq` is a
 * BigInt in Postgres and arrives over JSON as a string; parse it as a string and
 * convert once, at the boundary, rather than letting a lossy Number through.
 */
export const seqSchema = z
  .union([z.string().regex(/^\d+$/u), z.number().int().nonnegative()])
  .transform((value) => BigInt(value));

export const versionNumberSchema = z.number().int().positive();

/** An ISO 8601 instant. Always UTC on the wire; rendering picks a zone. */
export const instantSchema = z.string().datetime();

export type Id = z.infer<typeof idSchema>;
/** `Role` itself is exported from `../roles`, which owns the list. */
export type ShareRole = z.infer<typeof shareRoleSchema>;
export type VersionKind = z.infer<typeof versionKindSchema>;
