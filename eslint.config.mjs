import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config, linted from the repo root in one pass (`pnpm lint`). Deliberately
 * not a per-package turbo task: one config, one resolution root, no package
 * silently linting with no rules at all.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/db/generated/**',
      'design-canvas/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // info for process lifecycle (listening, draining), never per message: a
      // line per Yjs update is twenty lines a second per writer (CODESTYLE 14).
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      // TypeScript reports undefined identifiers with full type information.
      'no-undef': 'off',
    },
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      /**
       * The editor island boundary (docs/CODESTYLE.md 17).
       *
       * Only `components/editor/**` may import the CRDT stack. Anywhere else, an
       * import of `yjs` pulls a second module instance into a bundle that may
       * already have one (Yjs relies on `instanceof`, so two copies break it
       * silently), and an import into a server component evaluates the CRDT on
       * the server for nothing.
       */
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['yjs', 'y-indexeddb', 'y-protocols', '@hocuspocus/*', '@tiptap/*'],
              message:
                'The CRDT stack lives in components/editor/ only (docs/CODESTYLE.md 17). Pass data in, or add the code there.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/components/editor/**/*.ts', 'apps/web/components/editor/**/*.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    /**
     * `consistent-type-imports` is off for the Nest app, and not as a preference:
     * Nest resolves constructor dependencies from `emitDecoratorMetadata`, and an
     * `import type` erases the class so injection fails at boot with an error that
     * points nowhere near the import (docs/CODESTYLE.md 7).
     */
    files: ['apps/api/src/**/*.ts', 'apps/api/test/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // Seeds, scripts, tests and the E2E suite may talk to stdout.
    files: [
      'packages/db/prisma/**/*.mts',
      'scripts/**/*.mjs',
      '**/*.test.ts',
      'e2e/**/*.ts',
      '**/integration/**/*.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', 'apps/api/test/**/*.ts', '**/integration/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
