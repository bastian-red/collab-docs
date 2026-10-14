import { describe, expect, it } from 'vitest';

import { participantsFrom } from './participants';

const ana = { user: { id: 'u-ana', name: 'Ana Requena' } };
const bruno = { user: { id: 'u-bruno', name: 'Bruno Salas' } };
const clara = { user: { id: 'u-clara', name: 'Clara Mota' } };

describe('participantsFrom', () => {
  it('counts a person once however many tabs they have open', () => {
    const result = participantsFrom([ana, bruno, ana, ana], 'u-bruno');
    expect(result).toEqual([
      { userId: 'u-bruno', name: 'Bruno Salas', connections: 1 },
      { userId: 'u-ana', name: 'Ana Requena', connections: 3 },
    ]);
  });

  it('puts yourself first and everybody else in a stable order', () => {
    expect(participantsFrom([clara, bruno, ana], 'u-clara').map((p) => p.name)).toEqual([
      'Clara Mota',
      'Ana Requena',
      'Bruno Salas',
    ]);
  });

  it('skips clients that have not published a well-formed user yet', () => {
    expect(
      participantsFrom(
        [{}, null, { user: { id: 7, name: 'x' } }, { user: { id: 'a', name: '' } }, ana],
        'z',
      ),
    ).toEqual([{ userId: 'u-ana', name: 'Ana Requena', connections: 1 }]);
  });
});
