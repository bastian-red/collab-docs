import { cursorColour, initials } from '@docs/shared';

/**
 * Initials in the person's caret hue.
 *
 * The hue is the SAME function the editor's caret uses (`cursorColour`), so a
 * person is one colour in the list, in the participants stack and on the page.
 * The initials are decoration for a sighted reader; the name is always beside
 * them or in visually hidden text, because two people can share initials and
 * eight hues cannot stay apart (docs/DESIGN.md 2.4).
 */
export function Avatar({ userId, name }: { readonly userId: string; readonly name: string }) {
  const colour = cursorColour(userId);
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={
        {
          '--avatar-light': colour.light,
          '--avatar-dark': colour.dark,
          '--avatar-ink-light': colour.lightInk,
          '--avatar-ink-dark': colour.darkInk,
        } as React.CSSProperties
      }
    >
      {initials(name)}
    </span>
  );
}
