/**
 * Initials for an avatar chip.
 *
 * A second non-colour channel for identity: the chip carries initials, the caret
 * carries the full name, and the participants list carries both beside the
 * swatch. None of the three is colour.
 */

/**
 * At most two letters, from the first and last word of a name.
 *
 * `Array.from` rather than `split('')` or `name[0]`, because a name can begin
 * with a character outside the basic plane and indexing a JS string returns half
 * a surrogate pair, which renders as a replacement glyph. `toLocaleUpperCase`
 * rather than `toUpperCase` for the same class of reason.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';

  const first = firstGrapheme(words[0]!);
  if (words.length === 1) return first;
  return `${first}${firstGrapheme(words[words.length - 1]!)}`;
}

function firstGrapheme(word: string): string {
  return (Array.from(word)[0] ?? '').toLocaleUpperCase();
}
