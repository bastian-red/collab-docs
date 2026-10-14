import { describe, expect, it } from 'vitest';

import { initials } from './initials';

describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initials('Ana Requena')).toBe('AR');
    expect(initials('Ana Isabel Requena Mota')).toBe('AM');
  });

  it('takes one letter from a single word', () => {
    expect(initials('Ana')).toBe('A');
  });

  it('survives extra whitespace', () => {
    expect(initials('  Ana   Requena  ')).toBe('AR');
  });

  it('never returns an empty chip', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });

  it('does not split a surrogate pair in half', () => {
    // 'Bruno' with a mathematical bold B (U+1D401) is two code units. Indexing
    // with [0] would return a lone high surrogate, which renders as a tofu box
    // in the avatar and looks like a corrupted database row.
    expect(initials('\u{1D401}runo Salas')).toBe('\u{1D401}S');
  });
});
