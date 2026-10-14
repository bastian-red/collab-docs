import { describe, expect, it } from 'vitest';

import { ROLES, SHARE_ROLES } from '../roles';
import { roleSchema, seqSchema, shareRoleSchema, versionLabelSchema } from './primitives';

describe('roleSchema', () => {
  it('accepts exactly the roles the matrix knows about', () => {
    // The schema is built from ROLES, so this test is really asserting that the
    // build-from rather than copy-from is still in place.
    expect(roleSchema.options).toEqual([...ROLES]);
    for (const role of ROLES) expect(roleSchema.parse(role)).toBe(role);
    expect(roleSchema.safeParse('ADMIN').success).toBe(false);
  });
});

describe('shareRoleSchema', () => {
  it('refuses OWNER at the contract boundary', () => {
    expect(shareRoleSchema.options).toEqual([...SHARE_ROLES]);
    expect(shareRoleSchema.safeParse('OWNER').success).toBe(false);
  });
});

describe('seqSchema', () => {
  it('accepts the string form a BigInt takes over JSON', () => {
    expect(seqSchema.parse('1284')).toBe(1284n);
  });

  it('accepts a number, because a small seq serialises as one', () => {
    expect(seqSchema.parse(7)).toBe(7n);
  });

  it('survives a seq past Number.MAX_SAFE_INTEGER without losing digits', () => {
    // The whole reason seq crosses the wire as a string. As a JSON number this
    // value comes back as 9007199254740993 -> 9007199254740992, and a client
    // would then ask for a catch-up from one update earlier than it has.
    expect(seqSchema.parse('9007199254740993')).toBe(9007199254740993n);
  });

  it('refuses a decimal or a negative', () => {
    expect(seqSchema.safeParse('1.5').success).toBe(false);
    expect(seqSchema.safeParse('-1').success).toBe(false);
    expect(seqSchema.safeParse(-1).success).toBe(false);
  });
});

describe('versionLabelSchema', () => {
  it('turns an absent label into null, so `label === null` is the only spelling', () => {
    expect(versionLabelSchema.parse(undefined)).toBeNull();
    expect(versionLabelSchema.parse(null)).toBeNull();
  });

  it('trims', () => {
    expect(versionLabelSchema.parse('  before the rewrite  ')).toBe('before the rewrite');
  });

  it('refuses a label that is only whitespace rather than storing an empty one', () => {
    expect(versionLabelSchema.safeParse('   ').success).toBe(false);
  });
});
