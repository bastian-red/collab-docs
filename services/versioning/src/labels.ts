/**
 * Version labels: the one string in this product that a person types and that
 * another person later has to recognise in a list.
 *
 * Normalised once, here, before it is stored. The alternative -- normalising at
 * render time -- means the database holds one string, the panel shows another,
 * and a search for what is on screen finds nothing.
 */
import { DomainError } from '@docs/shared';

/** Matches `versionLabelSchema` in `@docs/shared`; the zod schema is the wire check, this is the store check. */
export const VERSION_LABEL_MAX = 80;

/**
 * Characters that are refused rather than stripped.
 *
 * The same set `scripts/invisible-chars.mjs` refuses in source, for the same
 * reason: a label with a U+200B in it is a label that looks identical to another
 * one, sorts unpredictably, and cannot be found by typing what is on screen.
 * Refusing beats stripping because stripping silently changes what somebody
 * wrote and they never learn why their two versions are both called "draft".
 *
 * U+0009 TAB and U+000A LINE FEED are absent from this list on purpose: they are
 * collapsed to a space below, because pasting a line from the document into the
 * label box is a thing people do and refusing it would be pedantry.
 */
const REFUSED_CODEPOINTS = new Set([
  0x00, 0x0b, 0x0c, 0x0d, 0x1b, 0x00a0, 0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028,
  0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0xfeff,
]);

function offendingCodepoint(value: string): number | null {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (REFUSED_CODEPOINTS.has(code)) return code;
    // Every other C0 control, so a new one never has to be added to the list by
    // hand. TAB and LINE FEED are already gone by this point.
    if (code < 0x20) return code;
    if (code === 0x7f) return code;
  }
  return null;
}

/**
 * The label as it will be stored, or a `DomainError`.
 *
 * NFC first: "café" typed on a Mac and "café" typed on Linux are different byte
 * sequences and compare unequal, so without normalisation the same label saved
 * twice is two different labels and neither `@@unique` nor a person's eye can
 * tell them apart.
 */
export function normaliseLabel(raw: string): string {
  const collapsed = raw
    .normalize('NFC')
    .replace(/[\t\n]+/gu, ' ')
    .replace(/ {2,}/gu, ' ')
    .trim();

  if (collapsed.length === 0) {
    throw new DomainError('INVALID', 'A version label cannot be blank');
  }
  if (collapsed.length > VERSION_LABEL_MAX) {
    throw new DomainError('INVALID', `A version label is at most ${VERSION_LABEL_MAX} characters`);
  }
  const offender = offendingCodepoint(collapsed);
  if (offender !== null) {
    const point = `U+${offender.toString(16).toUpperCase().padStart(4, '0')}`;
    throw new DomainError('INVALID', `A version label cannot contain ${point}`);
  }
  return collapsed;
}

/**
 * The database half of the same rule.
 *
 * `CHECK (kind <> 'MANUAL' OR label IS NOT NULL)` -- named
 * `document_versions_manual_has_label` -- refuses the row. This refuses it one
 * layer earlier with a message a person can act on. A manual version with no
 * label is a row nobody can identify in the panel, which is the same as a row
 * that is not there, except that it counts against the cap and pushes a real one
 * out.
 */
export function labelForKind(kind: 'AUTO' | 'MANUAL', raw: string | null): string | null {
  if (kind === 'AUTO') {
    // An automatic version is identified by its timestamp. A label on one would
    // be a label nobody wrote.
    if (raw !== null)
      throw new DomainError('INVALID', 'An automatic version does not take a label');
    return null;
  }
  if (raw === null) throw new DomainError('INVALID', 'A saved version needs a name');
  return normaliseLabel(raw);
}
