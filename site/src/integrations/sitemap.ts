import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

import { writeSitemaps } from '../lib/sitemap';

// Runs after the pages are written, so a page that was not built cannot be listed.
export function sitemaps(origin: string, dataDist: string | undefined): AstroIntegration {
  return {
    name: 'sitemaps',
    hooks: {
      'astro:build:done': ({ dir, logger }): void => {
        if (dataDist === undefined || dataDist === '') {
          throw new Error('the sitemaps need the data dist, for its release date');
        }
        const written = writeSitemaps(fileURLToPath(dir), origin, dataDist);
        logger.info(`wrote ${String(written.length)} sitemap files`);
      },
    },
  };
}
