import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unreasonedFilters } from './html-filters.ts';

// None of these need Java: the filter check runs before the checker starts.
const root = resolve(import.meta.dirname, '..');
const fixture = (name: string): string => resolve(import.meta.dirname, 'html-fixtures', name);
const read = (path: string): string => readFileSync(path, 'utf8');
const html = (filters: string): { status: number | null; stderr: string } =>
  spawnSync(process.execPath, ['scripts/html.ts', fixture('clean')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HTML_TEST: '1', HTML_FILTERS: filters },
  });

describe('the HTML gate filters', () => {
  it('accepts a filter file where every pattern has a reason above it', () => {
    expect(unreasonedFilters(read(fixture('filters/with-reasons.txt')))).toEqual([]);
    expect(
      unreasonedFilters(read(resolve(root, 'docs/refs/policies/html-validate-filters.txt'))),
    ).toEqual([]);
  });

  it('finds a pattern with no comment directly above it, and an empty comment', () => {
    expect(unreasonedFilters(read(fixture('filters/no-reason.txt')))).toEqual([
      'line 6: ^A pattern with no comment above it$',
    ]);
    expect(unreasonedFilters('#\n^empty comment$\n')).toEqual(['line 2: ^empty comment$']);
  });

  it('does not count the file header as the reason for the first pattern', () => {
    expect(unreasonedFilters(read(fixture('filters/header-only.txt')))).toEqual([
      'line 2: ^A pattern with only the header above it$',
    ]);
    expect(html(fixture('filters/header-only.txt')).status).toBe(1);
  });

  it('stops the command before the checker runs when a filter has no reason', () => {
    const r = html(fixture('filters/no-reason.txt'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('line 6: ^A pattern with no comment above it$');
  });

  it('keeps the checker version exact in package.json, in the lockfile and as installed', () => {
    const pkg = JSON.parse(read(resolve(root, 'package.json'))) as {
      devDependencies: Record<string, string>;
    };
    const pinned = pkg.devDependencies['vnu-jar'];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(read(resolve(root, 'package-lock.json'))) as {
      packages: Record<string, { version?: string }>;
    };
    expect(lock.packages['node_modules/vnu-jar']?.version).toBe(pinned);
    const installed = JSON.parse(read(resolve(root, 'node_modules/vnu-jar/package.json'))) as {
      version: string;
    };
    expect(installed.version).toBe(pinned);
  });
});
