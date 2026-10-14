import { splitSnippet } from '../lib/snippet';

/** A search snippet as text nodes and `<mark>`s. Never HTML; see `lib/snippet.ts`. */
export function Snippet({ text }: { readonly text: string }) {
  return (
    <>
      {splitSnippet(text).map((segment, index) =>
        segment.hit ? (
          <mark className="hit" key={index}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
