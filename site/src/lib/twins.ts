import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { twinPathOf } from '../../../worker/twins';
import { markdownTwin } from './markdown';

// Every directory page the build wrote; 404.html is not one, so an error page has no twin.
export const pageFiles = (dist: string): string[] =>
  readdirSync(dist, { recursive: true, encoding: 'utf8' })
    .filter((file) => file === 'index.html' || file.endsWith('/index.html'))
    .sort();

// The address a page file serves, such as /hospitals/ for hospitals/index.html.
export const addressOf = (file: string): string => `/${file.slice(0, -'index.html'.length)}`;

// Writes the twin of each page beside it and returns the twin paths.
export function writeTwins(dist: string, origin: string): string[] {
  return pageFiles(dist).map((file) => {
    const address = addressOf(file);
    const twin = twinPathOf(address);
    if (twin === undefined) {
      throw new Error(`${address} is not a page address`);
    }
    const html = readFileSync(join(dist, file), 'utf8');
    writeFileSync(join(dist, twin), markdownTwin(html, new URL(address, origin)));
    return twin;
  });
}
