import { describe, expect, it } from 'vitest';

import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from './next-path';

describe('safeNextPath keeps a reader on this origin', () => {
  it('returns a same-origin path with its query intact, which is the share-link case', () => {
    expect(safeNextPath('/d/cdocsync000000000000000?share=abcDEF_123-xyz')).toBe(
      '/d/cdocsync000000000000000?share=abcDEF_123-xyz',
    );
  });

  it.each([
    ['protocol-relative', '//evil.example/x'],
    ['backslash that browsers normalise to //', '/\\evil.example'],
    ['absolute https', 'https://evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['relative without a leading slash', 'd/abc'],
    ['a header-splitting newline', '/d/abc\r\nSet-Cookie: x=1'],
    ['a tab, which URL parsing strips silently', '/\t/evil.example'],
    ['empty', ''],
  ])('refuses %s', (_name, raw) => {
    expect(safeNextPath(raw)).toBe(DEFAULT_AFTER_SIGN_IN);
  });

  it('falls back when there is no value at all', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_AFTER_SIGN_IN);
    expect(safeNextPath(undefined)).toBe(DEFAULT_AFTER_SIGN_IN);
  });

  it('normalises dot segments rather than passing them through', () => {
    expect(safeNextPath('/d/../status')).toBe('/status');
  });
});
