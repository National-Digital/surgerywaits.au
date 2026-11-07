import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
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
});
