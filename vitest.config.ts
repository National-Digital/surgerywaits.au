import { configDefaults, defineConfig } from 'vitest/config';

// The browser proofs need Chromium, so only the Accessibility job runs them, with A11Y_TEST=1.
export default defineConfig({
  test: {
    exclude:
      process.env['A11Y_TEST'] === '1'
        ? configDefaults.exclude
        : [...configDefaults.exclude, 'scripts/a11y.test.ts'],
  },
});
