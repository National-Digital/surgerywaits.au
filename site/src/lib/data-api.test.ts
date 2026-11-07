import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { canonicalJson, dataApiBody, dataApiPaths } from './data-api';
import { contractSchemas, distDirectory, schemaFor } from './dist';

const WITHHELD = new Set(['not_published', 'not_reported']);

// Every object in the document that stands in a figure's place.
function figures(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      figures(item, found);
    }
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record['state'] === 'string' && 'period' in record) {
      found.push(record);
    }
    for (const item of Object.values(record)) {
      figures(item, found);
    }
  }
  return found;
}

describe('the data files', () => {
  const paths = dataApiPaths();

  it('lists every JSON file the dist holds, in order', () => {
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('index.json');
    expect(paths).toContain('credits.json');
    expect(paths.every((path) => !path.includes('SHA256SUMS'))).toBe(true);
  });

  it('holds each file to the schema for its family', () => {
    for (const path of paths) {
      expect(() => schemaFor(path), path).not.toThrow();
    }
  });

  it('publishes the same content as the dist, with the keys in order', () => {
    for (const path of paths) {
      const raw: unknown = JSON.parse(readFileSync(join(distDirectory(), path), 'utf8'));
      const body = dataApiBody(path);
      expect(JSON.parse(body), path).toEqual(raw);
      expect(body, path).toBe(canonicalJson(raw));
      expect(body.endsWith('}\n'), path).toBe(true);
    }
  }, 120_000);

  it('writes the same bytes whatever order the keys arrive in', () => {
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(reversed);
      }
      if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reversed(item)]),
        );
      }
      return value;
    };
    for (const path of paths.slice(0, 20)) {
      const raw: unknown = JSON.parse(readFileSync(join(distDirectory(), path), 'utf8'));
      expect(canonicalJson(reversed(raw)), path).toBe(dataApiBody(path));
    }
  });

  it('gives a withheld figure its reason and never a value', () => {
    let withheld = 0;
    for (const path of paths) {
      for (const figure of figures(JSON.parse(dataApiBody(path)))) {
        if (WITHHELD.has(figure['state'] as string)) {
          withheld += 1;
          expect('value' in figure, path).toBe(false);
          expect(typeof figure['reason'] === 'string' || figure['state'] === 'not_reported').toBe(
            true,
          );
        } else {
          expect(typeof figure['value'], path).toBe('number');
          expect(typeof figure['release'], path).toBe('string');
        }
      }
    }
    expect(withheld).toBeGreaterThan(0);
  }, 120_000);

  it('carries the sources of every file that has them, each credited', () => {
    const credited = new Set(
      (
        JSON.parse(dataApiBody('credits.json')) as { sources: { slug: string; licence: string }[] }
      ).sources.map((source) => source.slug),
    );
    for (const path of paths.filter((p) => p !== 'credits.json')) {
      const document = JSON.parse(dataApiBody(path)) as { sources?: string[] };
      for (const source of document.sources ?? []) {
        expect(credited.has(source), `${path} ${source}`).toBe(true);
      }
    }
  }, 120_000);

  it('publishes a schema for each family', () => {
    const names = contractSchemas().map(([name]) => name);
    expect(names).toContain('common');
    for (const path of paths) {
      expect(names, path).toContain(schemaFor(path));
    }
  });
});
