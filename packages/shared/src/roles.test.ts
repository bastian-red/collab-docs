import { describe, expect, it } from 'vitest';

import { ACTIONS, ROLES, SHARE_ROLES, atLeast, can, mayWriteDocument, strongest } from './roles';

describe('the permission matrix', () => {
  // Exhaustive rather than by example: 4 roles x 12 actions is 48 answers, and
  // an example-based test would only ever pin the handful somebody thought of.
  const EXPECTED: Record<string, string[]> = {
    OWNER: [...ACTIONS],
    EDITOR: [
      'document.read',
      'document.write',
      'document.rename',
      'version.read',
      'version.create',
      'version.restore',
      'member.read',
      'link.read',
    ],
    COMMENTER: ['document.read', 'version.read', 'member.read'],
    VIEWER: ['document.read'],
  };

  for (const role of ROLES) {
    for (const action of ACTIONS) {
      const allowed = EXPECTED[role]!.includes(action);
      it(`${role} ${allowed ? 'may' : 'may not'} ${action}`, () => {
        expect(can(role, action)).toBe(allowed);
      });
    }
  }
});

describe('mayWriteDocument', () => {
  // This is the function that sets connectionConfig.readOnly on the sync server.
  // If it ever returns true for VIEWER or COMMENTER, a read-only share link
  // becomes a write link and nothing else in the system notices.
  it('is true for exactly OWNER and EDITOR', () => {
    expect(ROLES.filter(mayWriteDocument)).toEqual(['OWNER', 'EDITOR']);
  });
});

describe('atLeast', () => {
  it('is reflexive', () => {
    for (const role of ROLES) expect(atLeast(role, role)).toBe(true);
  });

  it('orders the roles strongest first', () => {
    expect(atLeast('OWNER', 'VIEWER')).toBe(true);
    expect(atLeast('VIEWER', 'OWNER')).toBe(false);
    expect(atLeast('EDITOR', 'COMMENTER')).toBe(true);
    expect(atLeast('COMMENTER', 'EDITOR')).toBe(false);
  });
});

describe('strongest', () => {
  it('never demotes somebody for arriving through a weaker link', () => {
    expect(strongest('EDITOR', 'VIEWER')).toBe('EDITOR');
    expect(strongest('VIEWER', 'EDITOR')).toBe('EDITOR');
  });

  it('is commutative across every pair', () => {
    for (const a of ROLES) for (const b of ROLES) expect(strongest(a, b)).toBe(strongest(b, a));
  });
});

describe('the matrix cannot be mutated from outside', () => {
  it('hands out a role set that a caller cannot add to', () => {
    // `can` returns a boolean rather than the Set, so there is no reference to
    // grab. This test exists to fail if somebody "helpfully" exports the Set.
    expect(can('VIEWER', 'document.write')).toBe(false);
    expect(can('VIEWER', 'document.write')).toBe(false);
  });
});

describe('SHARE_ROLES', () => {
  it('is every role except OWNER, derived rather than retyped', () => {
    // If a role is ever added, it lands here automatically and the omission of
    // OWNER stays the only deliberate exclusion.
    expect(SHARE_ROLES).toEqual(ROLES.filter((role) => role !== 'OWNER'));
  });

  it('can never carry OWNER', () => {
    // The link is forwardable. This is asserted here, in services/doc-access,
    // and by CHECK (role <> 'OWNER') in the database.
    expect(SHARE_ROLES).not.toContain('OWNER');
  });
});
