import { defineConfig } from 'astro/config';

import { sitemaps } from './src/integrations/sitemap';
import { markdownTwins } from './src/integrations/twins';

// The preview build adds a development route and writes to its own folder, so the published
// build never holds it.
// Two flags, both set inline by build:preview, so a stray SURGERYWAITS_PREVIEW cannot redirect a plain build.
const preview =
  process.env['SURGERYWAITS_PREVIEW'] === '1' && process.env['SURGERYWAITS_PREVIEW_SCRIPT'] === '1';

const site = 'https://surgerywaits.au';

export default defineConfig({
  output: 'static',
  site,
  trailingSlash: 'always',
  build: { format: 'directory' },
  outDir: preview ? './dist-preview' : './dist',
  devToolbar: { enabled: false },
  // One sheet keeps the layer order ahead of the component layers that a page's own chunk would put first.
  vite: { build: { cssCodeSplit: false } },
  integrations: preview
    ? [
        {
          name: 'preview-routes',
          hooks: {
            'astro:config:setup': ({ injectRoute }): void => {
              injectRoute({ pattern: '/dev/primitives', entrypoint: './src/dev/primitives.astro' });
            },
          },
        },
      ]
    : [sitemaps(site, process.env['SURGERYWAITS_DIST']), markdownTwins(site)],
});
