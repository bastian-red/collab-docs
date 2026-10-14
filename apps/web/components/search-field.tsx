'use client';

import { useEffect, useRef } from 'react';

/**
 * Full-text search: a GET form, so a search is a URL a reader can share and the
 * back button undoes. `/` focuses it from anywhere on the page that is not
 * already a text field (docs/DESIGN.md 6), the convention GitHub and Gmail teach.
 */
export function SearchField({ initial }: { readonly initial: string }) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form className="search" role="search" action="/" method="get">
      <label className="sr-only" htmlFor="search-q">
        Search full text
      </label>
      <input
        ref={input}
        id="search-q"
        className="field-input search-input"
        type="search"
        name="q"
        defaultValue={initial}
        placeholder="Search full text"
        maxLength={200}
        aria-keyshortcuts="/"
      />
      <kbd className="search-key" aria-hidden="true">
        /
      </kbd>
    </form>
  );
}
