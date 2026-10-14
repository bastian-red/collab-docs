import type { Diff } from '@docs/shared';

/**
 * A text diff between a version and the live document.
 *
 * Additions and removals are `<ins>`/`<del>` with a `+`/`-` gutter, not colour
 * alone (docs/DESIGN.md 3.3): a strike-through on a green underline is still only
 * colour plus one line style, and `<ins>`/`<del>` are what a screen reader can
 * announce as inserted and deleted.
 */
export function DiffView({ n, diff }: { readonly n: number; readonly diff: Diff }) {
  return (
    <section className="diff" aria-labelledby="diff-heading">
      <h2 id="diff-heading" className="diff-title">
        Changes since version {n}
      </h2>
      <p className="diff-summary">
        <span>{diff.addedLines} lines added</span>, <span>{diff.removedLines} removed</span>
      </p>
      <ol className="diff-lines">
        {diff.lines.map((line, index) => (
          <li key={index} className="diff-line" data-kind={line.kind}>
            <span className="diff-gutter" aria-hidden="true">
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
            </span>
            {line.kind === 'added' ? (
              <ins>{line.text}</ins>
            ) : line.kind === 'removed' ? (
              <del>{line.text}</del>
            ) : (
              <span>{line.text}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
