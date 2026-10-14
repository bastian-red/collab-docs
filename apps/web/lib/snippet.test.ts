import { describe, expect, it } from 'vitest';

import { splitSnippet } from './snippet';

describe('splitSnippet turns markers into segments, never into markup', () => {
  it('splits hits out of the surrounding text', () => {
    expect(splitSnippet('the [[sync]] server and the [[sync]] log')).toEqual([
      { text: 'the ', hit: false },
      { text: 'sync', hit: true },
      { text: ' server and the ', hit: false },
      { text: 'sync', hit: true },
      { text: ' log', hit: false },
    ]);
  });

  it('keeps author-typed markup as inert text', () => {
    // The reason the markers are not `<b>`: this string is somebody's document.
    expect(splitSnippet('<img src=x onerror=alert(1)> [[hit]]')).toEqual([
      { text: '<img src=x onerror=alert(1)> ', hit: false },
      { text: 'hit', hit: true },
    ]);
  });

  it('pairs an opener with the next closer, and leaves a lone opener as plain text', () => {
    expect(splitSnippet('arrays like a[[0] and [[hit]]')).toEqual([
      { text: 'arrays like a', hit: false },
      { text: '0] and [[hit', hit: true },
    ]);
    expect(splitSnippet('no close [[ here')).toEqual([{ text: 'no close [[ here', hit: false }]);
  });

  it('returns nothing for an empty snippet and drops empty hits', () => {
    expect(splitSnippet('')).toEqual([]);
    expect(splitSnippet('a[[]]b')).toEqual([
      { text: 'a', hit: false },
      { text: 'b', hit: false },
    ]);
  });
});
