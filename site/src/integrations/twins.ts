import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

import { writeTwins } from '../lib/twins';

// Runs after the pages are written, so each twin is cut from the page that was built.
export function markdownTwins(origin: string): AstroIntegration {
  return {
    name: 'markdown-twins',
    hooks: {
      'astro:build:done': ({ dir, logger }): void => {
        const written = writeTwins(fileURLToPath(dir), origin);
        logger.info(`wrote ${String(written.length)} Markdown twins`);
      },
    },
  };
}
