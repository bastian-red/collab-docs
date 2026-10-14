import { defineConfig } from 'vitest/config';

// Pure helpers and the four design gates. Component behaviour is the Playwright
// suite's job, so there is no jsdom here: the gates read the real stylesheet and
// layout off disk, which needs node and nothing else.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'components/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
