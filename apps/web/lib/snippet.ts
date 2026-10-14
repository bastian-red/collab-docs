/**
 * A search snippet, as text and highlight segments.
 *
 * The API asks `ts_headline` for `[[` and `]]` around each hit rather than the
 * default `<b>`, because `content_text` is whatever somebody typed into a document
 * and a snippet that mixes author text with markup is an injection point the
 * moment a renderer trusts it (docs/SPECS.md 4.6). So the snippet is SPLIT here
 * into plain strings, and the component renders each one as a text node or a
 * `<mark>`. React escapes text nodes; nothing here is ever HTML.
 *
 * Unbalanced markers (a `[[` with no `]]`, which happens when a document itself
 * contains the characters) degrade to plain text rather than highlighting the rest
 * of the snippet.
 */
export interface SnippetSegment {
  readonly text: string;
  readonly hit: boolean;
}

export function splitSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let rest = snippet;

  while (rest.length > 0) {
    const open = rest.indexOf('[[');
    if (open === -1) break;
    const close = rest.indexOf(']]', open + 2);
    if (close === -1) break;
    if (open > 0) segments.push({ text: rest.slice(0, open), hit: false });
    const hit = rest.slice(open + 2, close);
    if (hit.length > 0) segments.push({ text: hit, hit: true });
    rest = rest.slice(close + 2);
  }
  if (rest.length > 0) segments.push({ text: rest, hit: false });
  return segments;
}
