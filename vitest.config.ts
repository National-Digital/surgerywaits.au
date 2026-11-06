import { configDefaults, defineConfig } from 'vitest/config';

// The browser proofs need Chromium, so only the Accessibility job runs them, with A11Y_TEST=1.
// The built-CSS proof needs a build, so only the build job runs it, with BUILT_CSS=1.
const exclude = [...configDefaults.exclude];
if (process.env['A11Y_TEST'] !== '1') {
  exclude.push('scripts/a11y.test.ts');
}
if (process.env['BUILT_CSS'] !== '1') {
  exclude.push('site/src/styles/built-css.test.ts');
}

export default defineConfig({ test: { exclude } });
