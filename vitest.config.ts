import { getViteConfig } from 'astro/config';
import { configDefaults } from 'vitest/config';

// The browser proofs need Chromium, so only the Accessibility job runs them, with A11Y_TEST=1.
// The compare tool proof drives the built site in Chromium, so it needs a build and TOOL_TEST=1.
// The built-CSS proof needs a build, so only the build job runs it, with BUILT_CSS=1.
// The built-page proofs also need a build, and the same job runs them with BUILT_PAGES=1.
// The HTML gate proofs need Java, so only the job that installs it runs them, with HTML_TEST=1.
// The determinism proof builds a second time and compares, so it is opt-in with BUILD_TWICE=1.
const exclude = [...configDefaults.exclude];
if (process.env['A11Y_TEST'] !== '1') {
  exclude.push('scripts/a11y.test.ts', 'scripts/layout.test.ts');
}
if (process.env['TOOL_TEST'] !== '1') {
  exclude.push('scripts/tool.test.ts');
}
if (process.env['BUILT_CSS'] !== '1') {
  exclude.push('site/src/styles/built-css.test.ts');
}
if (process.env['BUILT_PAGES'] !== '1') {
  exclude.push(
    'site/src/contracts/built-pages.test.ts',
    'site/src/contracts/sitemaps.test.ts',
    'site/src/contracts/data-api.test.ts',
    'site/src/contracts/surfaces.test.ts',
  );
}
if (process.env['HTML_TEST'] !== '1') {
  exclude.push('scripts/html.test.ts');
}
if (process.env['BUILD_TWICE'] !== '1') {
  exclude.push('site/src/contracts/determinism.test.ts');
}

// Astro's own Vite config lets Vitest compile .astro files for the container API.
export default getViteConfig(
  {
    root: import.meta.dirname,
    resolve: {
      alias: {
        'astro:content': new URL('./site/src/lib/test-content.ts', import.meta.url).pathname,
      },
    },
    test: {
      exclude,
      // A real dist holds hundreds of pages, and each scan parses them all.
      testTimeout: process.env['BUILT_PAGES'] === '1' ? 120_000 : 5_000,
      // A bare `npm test` reads the fixture dist at its usual place; CI sets the variable itself.
      env: {
        SURGERYWAITS_DIST:
          process.env['SURGERYWAITS_DIST'] ??
          new URL('./pipeline/dist-fixture/', import.meta.url).pathname.replace(/\/$/, ''),
      },
    },
  },
  { root: './site' },
);
