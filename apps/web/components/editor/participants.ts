/**
 * Who is on the document, from the awareness states.
 *
 * One entry per PERSON, not per connection: the same person in two tabs is two
 * awareness clients and one participant. Counting connections as people is how a
 * presence list ends up saying "3 people" when one person has three tabs open.
 * Entries without a well-formed user (a client that has not published one yet) are
 * skipped rather than rendered as "undefined".
 */
import type { Participant } from './types';

export function participantsFrom(states: Iterable<unknown>, selfId: string): Participant[] {
  const byUser = new Map<string, Participant>();
  for (const state of states) {
    const user = (state as { user?: { id?: unknown; name?: unknown } } | null)?.user;
    if (typeof user?.id !== 'string' || typeof user.name !== 'string' || user.name.length === 0)
      continue;
    const existing = byUser.get(user.id);
    byUser.set(user.id, {
      userId: user.id,
      name: user.name,
      connections: (existing?.connections ?? 0) + 1,
    });
  }
  // Yourself first, then everybody else by name, so the stack does not reshuffle
  // every time somebody's awareness heartbeat arrives in a different order.
  return [...byUser.values()].sort((a, b) =>
    a.userId === selfId ? -1 : b.userId === selfId ? 1 : a.name.localeCompare(b.name, 'en'),
  );
}
