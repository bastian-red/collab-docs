import { z } from 'zod';

import {
  idSchema,
  instantSchema,
  nameSchema,
  versionKindSchema,
  versionLabelSchema,
  versionNumberSchema,
} from './primitives';

export const versionSummarySchema = z.object({
  id: idSchema,
  n: versionNumberSchema,
  kind: versionKindSchema,
  label: z.string().nullable(),
  /**
   * Who CUT the version. Not who wrote the text: with garbage collection on
   * there is no per-character attribution, and the UI must not imply there is.
   * See docs/SPECS.md section 5.3.
   */
  authorName: nameSchema.nullable(),
  createdAt: instantSchema,
  /** Encoded size of the stored state, rendered in the panel beside the label. */
  bytes: z.number().int().nonnegative(),
});

export const createVersionSchema = z.object({ label: versionLabelSchema });

/**
 * A text-level diff between two versions, computed server-side in
 * `services/versioning`.
 *
 * Line-oriented rather than character-oriented, because a character diff of
 * reflowed prose is noise. `kind` carries the meaning; the renderer adds a
 * strike or a rule on top of the colour, never colour alone.
 */
export const diffLineSchema = z.object({
  kind: z.enum(['added', 'removed', 'unchanged']),
  text: z.string(),
});

export const diffSchema = z.object({
  from: versionNumberSchema,
  /** Null means "against the live document" rather than against a version. */
  to: versionNumberSchema.nullable(),
  lines: z.array(diffLineSchema),
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
});

/**
 * A version's stored state, for a client about to restore it.
 *
 * base64: a Yjs update is binary and JSON has no binary type. Checked as base64
 * here so a client never hands `atob` something that throws halfway through a
 * restore.
 */
export const versionStateSchema = z.object({
  n: versionNumberSchema,
  state: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u),
});

export type VersionSummary = z.infer<typeof versionSummarySchema>;
export type DiffLine = z.infer<typeof diffLineSchema>;
export type Diff = z.infer<typeof diffSchema>;
export type VersionState = z.infer<typeof versionStateSchema>;
