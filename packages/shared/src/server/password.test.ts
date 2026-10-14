import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password';

describe('hashPassword', () => {
  it('salts, so the same password hashes differently every time', () => {
    const password = 'correct horse battery staple';
    expect(hashPassword(password)).not.toBe(hashPassword(password));
  });

  it('is verifiable', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('correct horse battery stapl', stored)).toBe(false);
  });
});

describe('verifyPassword', () => {
  it('returns false rather than throwing on a corrupted stored value', () => {
    // A row with a mangled hash must fail to authenticate, not 500. A crash
    // here tells an attacker which accounts have unusual rows.
    for (const stored of [
      '',
      'garbage',
      'scrypt:only-two',
      'bcrypt:aa:bb',
      'scrypt::',
      'scrypt:aa:zz',
    ]) {
      expect(() => verifyPassword('anything', stored)).not.toThrow();
      expect(verifyPassword('anything', stored)).toBe(false);
    }
  });
});
