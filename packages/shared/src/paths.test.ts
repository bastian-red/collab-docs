import { describe, expect, it } from 'vitest';

import { SHARE_PARAM, documentPath, shareLinkUrl } from './paths';

describe('documentPath', () => {
  it('is the route the web app serves a document on', () => {
    expect(documentPath('clq1234567890abcdefghij')).toBe('/d/clq1234567890abcdefghij');
  });
});

describe('shareLinkUrl', () => {
  it('carries the token in the share parameter', () => {
    expect(shareLinkUrl('http://localhost:3000', 'clq1234567890abcdefghij', 'tok-en')).toBe(
      'http://localhost:3000/d/clq1234567890abcdefghij?share=tok-en',
    );
  });

  // A base with a trailing slash is what somebody actually writes in .env. String
  // concatenation turns it into `//d/...`, which a browser resolves as a
  // protocol-relative URL pointing at a host called `d`.
  it('is unchanged by a trailing slash on the base', () => {
    const withSlash = shareLinkUrl('http://localhost:3000/', 'clq1234567890abcdefghij', 'tok-en');
    const without = shareLinkUrl('http://localhost:3000', 'clq1234567890abcdefghij', 'tok-en');
    expect(withSlash).toBe(without);
  });

  // base64url tokens contain `-` and `_`, which need no escaping, but a token is
  // opaque and the encoder has to hold for whatever it is.
  it('percent-encodes a token that needs it', () => {
    expect(shareLinkUrl('http://localhost:3000', 'clq1234567890abcdefghij', 'a b+c')).toBe(
      'http://localhost:3000/d/clq1234567890abcdefghij?share=a+b%2Bc',
    );
  });

  it('names the parameter the sync handshake reads', () => {
    expect(SHARE_PARAM).toBe('share');
  });
});
