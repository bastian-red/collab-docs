import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { mintServiceToken, readBearer, verifyServiceToken } from './service-token';

const SECRET = 'test-secret-at-least-32-characters-long';
const USER = { id: 'cm4x9q2p70000abcd1234efgh', email: 'ana@collab.test', name: 'Ana Requena' };

describe('mint and verify', () => {
  it('round-trips a user', () => {
    const result = verifyServiceToken(mintServiceToken(USER, SECRET), SECRET);
    expect(result).toEqual({ ok: true, user: USER });
  });

  it('refuses a token signed with a different secret', () => {
    const token = mintServiceToken(USER, 'a-completely-different-secret-value');
    expect(verifyServiceToken(token, SECRET)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses an expired token', () => {
    const token = mintServiceToken(USER, SECRET, -1);
    expect(verifyServiceToken(token, SECRET)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a token that is not a token', () => {
    expect(verifyServiceToken('', SECRET).ok).toBe(false);
    expect(verifyServiceToken('not.a.jwt', SECRET).ok).toBe(false);
  });
});

describe('the algorithm pin', () => {
  it('refuses alg:none, which is the forgery this pin exists to stop', () => {
    // Without `algorithms: ['HS256']`, jsonwebtoken honours the alg header on
    // the token itself and this unsigned token verifies as Ana.
    const forged = jwt.sign({ email: USER.email, name: USER.name }, '', {
      algorithm: 'none',
      subject: USER.id,
    });
    expect(verifyServiceToken(forged, SECRET)).toEqual({ ok: false, reason: 'signature' });
  });
});

describe('the claims are parsed, not cast', () => {
  it('refuses a token with no subject', () => {
    // A cast would produce a user whose id is undefined, and in Prisma
    // `undefined` is not "no rows", it is "no filter": the first query would
    // return somebody else's document.
    const token = jwt.sign({ email: USER.email, name: USER.name }, SECRET, { algorithm: 'HS256' });
    expect(verifyServiceToken(token, SECRET)).toEqual({ ok: false, reason: 'claims' });
  });

  it('refuses a token whose email is not an email', () => {
    const token = jwt.sign({ email: 'not-an-email', name: USER.name }, SECRET, {
      algorithm: 'HS256',
      subject: USER.id,
    });
    expect(verifyServiceToken(token, SECRET)).toEqual({ ok: false, reason: 'claims' });
  });

  it('refuses a token with a blank name', () => {
    const token = jwt.sign({ email: USER.email, name: '   ' }, SECRET, {
      algorithm: 'HS256',
      subject: USER.id,
    });
    expect(verifyServiceToken(token, SECRET)).toEqual({ ok: false, reason: 'claims' });
  });
});

describe('readBearer', () => {
  it('accepts any case of the scheme, per RFC 7235', () => {
    expect(readBearer('Bearer abc')).toBe('abc');
    expect(readBearer('bearer abc')).toBe('abc');
    expect(readBearer('BEARER abc')).toBe('abc');
  });

  it('rejects anything else rather than guessing', () => {
    expect(readBearer(undefined)).toBeNull();
    expect(readBearer('')).toBeNull();
    expect(readBearer('abc')).toBeNull();
    expect(readBearer('Basic abc')).toBeNull();
    expect(readBearer('Bearer')).toBeNull();
    expect(readBearer('Bearer a b')).toBeNull();
  });

  it('reads the first value when a proxy duplicated the header', () => {
    expect(readBearer(['Bearer abc', 'Bearer def'])).toBe('abc');
  });
});
