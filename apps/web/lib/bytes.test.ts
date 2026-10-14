import { describe, expect, it } from 'vitest';

import { formatBytes } from './bytes';

describe('formatBytes', () => {
  // Expected strings computed by running the function, then pasted
  // (docs/CODESTYLE.md section 12), not recalled.
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [43_110, '42.1 KiB'],
    [5_242_880, '5.0 MiB'],
    [-1, '0 B'],
    [Number.NaN, '0 B'],
  ])('%d bytes is %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
