'use client';

import { Avatar } from '../avatar';
import type { Participant } from './types';

/**
 * Who is here. Avatars for a glance, and a list with every name for everybody
 * else: initials collide and hues blur, so the names are the actual channel.
 */
export function ParticipantStack({ participants }: { readonly participants: Participant[] }) {
  if (participants.length === 0) return null;
  const shown = participants.slice(0, 4);
  return (
    <div className="participants">
      <ul className="participants-avatars" aria-label={`${participants.length} here now`}>
        {shown.map((person) => (
          <li key={person.userId} title={person.name}>
            <Avatar userId={person.userId} name={person.name} />
            <span className="sr-only">
              {person.name}
              {person.connections > 1 ? `, ${String(person.connections)} windows` : ''}
            </span>
          </li>
        ))}
      </ul>
      {participants.length > shown.length ? (
        <span className="participants-more">+{participants.length - shown.length}</span>
      ) : null}
    </div>
  );
}
