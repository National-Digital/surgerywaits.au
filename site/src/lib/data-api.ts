import { readdirSync } from 'node:fs';

import { distDirectory, readDist } from './dist';

// Keys are sorted and arrays keep the order the pipeline gave them, so two builds write the same bytes.
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sorted(value))}\n`;
}

// Every JSON file in the dist, named by its path there. A file the contract does not describe throws.
export function dataApiPaths(): string[] {
  return readdirSync(distDirectory(), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.json'))
    .sort();
}

// readDist proves the file against its schema first, so nothing unchecked is published.
export function dataApiBody(path: string): string {
  return canonicalJson(readDist(path));
}
