import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The checker needs Java, so only the job that installs it runs these, with HTML_TEST=1.
const root = resolve(import.meta.dirname, '..');
const check = (dir: string): SpawnSyncReturns<string> =>
  spawnSync(
    process.execPath,
    ['scripts/html.ts', resolve(import.meta.dirname, 'html-fixtures', dir)],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );

describe('the HTML gate', () => {
  it('passes a valid page', () => {
    const r = check('clean');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails a page with an error', () => {
    const r = check('fail-error');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('must have an “alt” attribute');
  });

  it('fails a page that has only a warning, because warnings are errors', () => {
    const r = check('fail-warning');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Section lacks heading');
  });

  it('fails when the directory is missing or holds no HTML file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'html-'));
    try {
      const empty = check(dir);
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain('no HTML files');
      const missing = check(join(dir, 'absent'));
      expect(missing.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
