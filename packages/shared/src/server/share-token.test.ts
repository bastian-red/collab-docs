import { describe, expect, it } from 'vitest';

import { mintShareToken, shareTokensMatch } from './share-token';

describe('mintShareToken', () => {
  it('is base64url, so it needs no escaping in a URL', () => {
    for (let i = 0; i < 50; i += 1) expect(mintShareToken()).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('carries 32 bytes of entropy', () => {
    // 32 bytes is 43 base64url characters with no padding.
    expect(mintShareToken()).toHaveLength(43);
  });

  it('never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(mintShareToken());
    expect(seen.size).toBe(2000);
  });
});

describe('shareTokensMatch', () => {
  it('matches an identical token', () => {
    const token = mintShareToken();
    expect(shareTokensMatch(token, token)).toBe(true);
  });

  it('refuses a different token of the same length', () => {
    expect(shareTokensMatch(mintShareToken(), mintShareToken())).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws on unequal lengths, and a throw is a far louder
    // timing signal than the comparison it was protecting.
    expect(() => shareTokensMatch('short', mintShareToken())).not.toThrow();
    expect(shareTokensMatch('short', mintShareToken())).toBe(false);
    expect(shareTokensMatch('', '')).toBe(true);
  });
});
