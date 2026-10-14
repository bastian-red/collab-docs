import { isDomainError } from '@docs/shared';
import { describe, expect, it } from 'vitest';

import { VERSION_LABEL_MAX, labelForKind, normaliseLabel } from './labels.js';

function code(fn: () => unknown): string {
  try {
    fn();
    return 'did not throw';
  } catch (error) {
    return isDomainError(error) ? error.code : `not a DomainError: ${String(error)}`;
  }
}

describe('normaliseLabel', () => {
  it('keeps an ordinary label as it was typed', () => {
    expect(normaliseLabel('before the rewrite')).toBe('before the rewrite');
  });

  it('trims and collapses whitespace, so two labels that look identical are identical', () => {
    expect(normaliseLabel('  before   the rewrite  ')).toBe('before the rewrite');
    expect(normaliseLabel('pasted\nfrom the document')).toBe('pasted from the document');
    expect(normaliseLabel('tabbed\tacross')).toBe('tabbed across');
  });

  it('normalises to NFC, so the same word typed on two machines is one label', () => {
    // U+0065 U+0301 (e followed by combining acute) and U+00E9 render
    // identically and compare unequal. Written as escapes because the two forms
    // are indistinguishable in an editor, in a terminal and in a diff.
    const decomposed = 'caf\u0065\u0301';
    const composed = 'caf\u00e9';
    expect(decomposed).not.toBe(composed);
    expect(normaliseLabel(decomposed)).toBe(composed);
  });

  it('refuses a label that is only whitespace', () => {
    expect(code(() => normaliseLabel('   '))).toBe('INVALID');
    expect(code(() => normaliseLabel(''))).toBe('INVALID');
  });

  it('accepts exactly the maximum length and refuses one more', () => {
    const at = 'x'.repeat(VERSION_LABEL_MAX);
    expect(normaliseLabel(at)).toBe(at);
    expect(code(() => normaliseLabel(`${at}x`))).toBe('INVALID');
  });

  it('measures the length after collapsing, not before', () => {
    // Otherwise a label of 40 words separated by double spaces is refused for
    // being 159 characters, which is not the length the person sees.
    const spaced = 'x '.repeat(VERSION_LABEL_MAX / 2).trim();
    expect(normaliseLabel(`  ${spaced}  `).length).toBeLessThanOrEqual(VERSION_LABEL_MAX);
  });

  it('refuses every invisible character the source scanner refuses', () => {
    // A label with a zero-width space is a label that looks identical to another
    // one and cannot be found by typing what is on screen. Refused rather than
    // stripped: stripping changes what somebody wrote and never tells them.
    //
    // Escapes, never the characters themselves. scripts/invisible-chars.mjs
    // would refuse this file for holding them, and a reviewer would see two
    // string literals that look the same and behave differently.
    const refused: ReadonlyArray<readonly [string, string]> = [
      ['\u0000', 'U+0000 NULL'],
      ['\u000b', 'U+000B VERTICAL TAB'],
      ['\u000c', 'U+000C FORM FEED'],
      ['\u000d', 'U+000D CARRIAGE RETURN'],
      ['\u001b', 'U+001B ESCAPE'],
      ['\u007f', 'U+007F DELETE'],
      ['\u00a0', 'U+00A0 NO-BREAK SPACE'],
      ['\u00ad', 'U+00AD SOFT HYPHEN'],
      ['\u200b', 'U+200B ZERO WIDTH SPACE'],
      ['\u200c', 'U+200C ZERO WIDTH NON-JOINER'],
      ['\u200d', 'U+200D ZERO WIDTH JOINER'],
      ['\u200e', 'U+200E LEFT-TO-RIGHT MARK'],
      ['\u200f', 'U+200F RIGHT-TO-LEFT MARK'],
      ['\u2028', 'U+2028 LINE SEPARATOR'],
      ['\u2029', 'U+2029 PARAGRAPH SEPARATOR'],
      ['\u202a', 'U+202A LEFT-TO-RIGHT EMBEDDING'],
      ['\u202e', 'U+202E RIGHT-TO-LEFT OVERRIDE'],
      ['\u2060', 'U+2060 WORD JOINER'],
      ['\ufeff', 'U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)'],
    ];
    for (const [character, name] of refused) {
      expect(
        code(() => normaliseLabel(`draft${character}two`)),
        name,
      ).toBe('INVALID');
    }
  });

  it('names the codepoint it refused, so the person can find it', () => {
    let message = '';
    try {
      normaliseLabel('draft\u200btwo');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('U+200B');
  });

  it('keeps a non-Latin label intact', () => {
    expect(normaliseLabel('  版本一  ')).toBe('版本一');
    expect(normaliseLabel('черновик')).toBe('черновик');
  });
});

describe('labelForKind', () => {
  it('requires a label for a version a person saved', () => {
    // The database says the same thing in `document_versions_manual_has_label`.
    // This says it one layer earlier, with a message somebody can act on.
    expect(code(() => labelForKind('MANUAL', null))).toBe('INVALID');
    expect(labelForKind('MANUAL', '  first draft ')).toBe('first draft');
  });

  it('refuses a label on an automatic version rather than storing one nobody wrote', () => {
    expect(labelForKind('AUTO', null)).toBeNull();
    expect(code(() => labelForKind('AUTO', 'auto'))).toBe('INVALID');
  });
});
