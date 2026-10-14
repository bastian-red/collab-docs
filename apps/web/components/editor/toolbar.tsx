'use client';

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * The formatting toolbar.
 *
 * `role="toolbar"` with a roving tabindex: Tab enters it once and leaves it once,
 * and the arrow keys move between buttons, which is the WAI-ARIA toolbar pattern.
 * Without it a keyboard user tabs through fifteen buttons to get from the title to
 * the document every single time.
 *
 * Marks are toggle buttons with `aria-pressed`, so a screen reader says "Bold,
 * toggle button, pressed" where a sighted reader sees a filled button. The state
 * comes from `useEditorState`, which re-renders on selection changes without
 * re-rendering the editor itself.
 *
 * Undo and redo are the Collaboration extension's Yjs commands, which undo only
 * this writer's own changes. StarterKit's history is disabled in the surface.
 */
interface ToolbarState {
  readonly block: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly bulletList: boolean;
  readonly orderedList: boolean;
  readonly blockquote: boolean;
  readonly codeBlock: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

const BLOCKS = [
  ['paragraph', 'Body text'],
  ['h1', 'Heading 1'],
  ['h2', 'Heading 2'],
  ['h3', 'Heading 3'],
] as const;

export function Toolbar({ editor }: { readonly editor: Editor }) {
  const state = useEditorState<ToolbarState>({
    editor,
    selector: ({ editor: current }) => ({
      block: current.isActive('heading', { level: 1 })
        ? 'h1'
        : current.isActive('heading', { level: 2 })
          ? 'h2'
          : current.isActive('heading', { level: 3 })
            ? 'h3'
            : 'paragraph',
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      strike: current.isActive('strike'),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      blockquote: current.isActive('blockquote'),
      codeBlock: current.isActive('codeBlock'),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });
  const bar = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = [...(bar.current?.querySelectorAll<HTMLElement>('[data-roving]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    for (const [position, item] of items.entries()) item.tabIndex = position === next ? 0 : -1;
    items[next]?.focus();
  };

  const chain = () => editor.chain().focus();

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting" ref={bar} onKeyDown={onKeyDown}>
      <label className="sr-only" htmlFor="block-style">
        Paragraph style
      </label>
      <select
        id="block-style"
        className="toolbar-select"
        data-roving
        tabIndex={0}
        value={state.block}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'paragraph') chain().setParagraph().run();
          else
            chain()
              .setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 })
              .run();
        }}
      >
        {BLOCKS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <span className="toolbar-sep" aria-hidden="true" />
      <Toggle label="Bold" pressed={state.bold} onPress={() => chain().toggleBold().run()}>
        <b>B</b>
      </Toggle>
      <Toggle label="Italic" pressed={state.italic} onPress={() => chain().toggleItalic().run()}>
        <i>I</i>
      </Toggle>
      <Toggle
        label="Underline"
        pressed={state.underline}
        onPress={() => chain().toggleUnderline().run()}
      >
        <u>U</u>
      </Toggle>
      <Toggle
        label="Strikethrough"
        pressed={state.strike}
        onPress={() => chain().toggleStrike().run()}
      >
        <s>S</s>
      </Toggle>
      <span className="toolbar-sep" aria-hidden="true" />
      <Toggle
        label="Bulleted list"
        pressed={state.bulletList}
        onPress={() => chain().toggleBulletList().run()}
      >
        •
      </Toggle>
      <Toggle
        label="Numbered list"
        pressed={state.orderedList}
        onPress={() => chain().toggleOrderedList().run()}
      >
        1.
      </Toggle>
      <Toggle
        label="Quote"
        pressed={state.blockquote}
        onPress={() => chain().toggleBlockquote().run()}
      >
        “
      </Toggle>
      <Toggle
        label="Code block"
        pressed={state.codeBlock}
        onPress={() => chain().toggleCodeBlock().run()}
      >
        {'</>'}
      </Toggle>
      <span className="toolbar-sep" aria-hidden="true" />
      <Action
        label="Undo your last change"
        disabled={!state.canUndo}
        onPress={() => chain().undo().run()}
      >
        ↶
      </Action>
      <Action label="Redo" disabled={!state.canRedo} onPress={() => chain().redo().run()}>
        ↷
      </Action>
    </div>
  );
}

function Toggle({
  label,
  pressed,
  onPress,
  children,
}: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="tool"
      data-roving
      tabIndex={-1}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onPress}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

function Action({
  label,
  disabled,
  onPress,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="tool"
      data-roving
      tabIndex={-1}
      aria-label={label}
      title={label}
      aria-disabled={disabled}
      onClick={() => {
        // aria-disabled rather than disabled, so the button stays in the roving
        // order and a keyboard user does not lose their place when it greys out.
        if (!disabled) onPress();
      }}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}
