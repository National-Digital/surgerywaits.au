import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { formatVersion, latestVersion, nextVersion, parseTag, releaseFor } from './next-version';

const next = (tags: string[], subject: string): string => formatVersion(nextVersion(tags, subject));

describe('the release number', () => {
  it('reads only v<major>.<minor>.<patch> as a tag', () => {
    expect(parseTag('v1.2.3')).toEqual([1, 2, 3]);
    for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc1', 'v01.2.3', 'release-1', 'v1.2.3.4']) {
      expect(parseTag(bad), bad).toBeNull();
    }
  });

  it('takes the highest tag by number, not by text', () => {
    expect(latestVersion(['v1.9.0', 'v1.10.0', 'v1.2.30', 'nightly'])).toEqual([1, 10, 0]);
    expect(latestVersion(['v2.0.0', 'v10.0.0', 'v9.9.9'])).toEqual([10, 0, 0]);
    expect(latestVersion([])).toBeNull();
    expect(latestVersion(['nightly'])).toBeNull();
  });

  it('bumps the minor number for feat, with or without a scope', () => {
    expect(next(['v1.4.2'], 'feat: add a tool')).toBe('1.5.0');
    expect(next(['v1.4.2'], 'feat(site): add a page')).toBe('1.5.0');
    expect(next(['v1.4.2'], 'FEAT: add a page')).toBe('1.5.0');
  });

  it('bumps the patch number for every other type and for a subject that is not conventional', () => {
    for (const subject of [
      'fix: a bug',
      'chore: tidy',
      'docs: words',
      'ci: a job',
      'perf(worker): faster',
      'Update the readme',
      'feature: not a type',
      '',
    ]) {
      expect(next(['v1.4.2'], subject), subject).toBe('1.4.3');
    }
  });

  it('bumps the major number only for a ! after the type or scope, or a BREAKING CHANGE note', () => {
    expect(next(['v1.4.2'], 'feat!: drop a file')).toBe('2.0.0');
    expect(next(['v1.4.2'], 'fix(worker)!: change a header')).toBe('2.0.0');
    expect(next(['v1.4.2'], 'fix: x\n\nBREAKING CHANGE: y')).toBe('2.0.0');
    expect(next(['v1.4.2'], 'fix: x\n\nbody\nBREAKING-CHANGE: y')).toBe('2.0.0');
    expect(next(['v1.4.2'], 'feat: wow! great')).toBe('1.5.0');
    expect(next(['v1.4.2'], 'chore: x BREAKING CHANGE: y')).toBe('1.4.3');
    expect(next(['v1.4.2'], 'fix: x\n\nthis is not a BREAKING CHANGE: y')).toBe('1.4.3');
    expect(next(['v1.4.2'], 'fix: x\n\nBREAKING CHANGES y')).toBe('1.4.3');
  });

  it('starts from 1.0.0 when there is no tag', () => {
    expect(next([], 'fix: a bug')).toBe('1.0.1');
    expect(next([], 'feat: a thing')).toBe('1.1.0');
    expect(next(['nightly'], 'feat!: a thing')).toBe('2.0.0');
  });
});

describe('a commit that already has a release', () => {
  it('keeps the version of its own tag, and takes the next number only without one', () => {
    const tags = ['v1.4.2', 'v1.5.0'];
    expect(formatVersion(releaseFor(['v1.5.0'], tags, 'feat: again'))).toBe('1.5.0');
    expect(formatVersion(releaseFor(['v1.4.2', 'v1.5.0'], tags, 'fix: again'))).toBe('1.5.0');
    expect(formatVersion(releaseFor([], tags, 'feat: new'))).toBe('1.6.0');
  });
});

describe('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-version-'));
  const script = new URL('next-version.ts', import.meta.url).pathname;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.test',
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  const run = (...args: string[]): string =>
    execFileSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the base, the current tag, the next number and a tag on HEAD', () => {
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'chore: init commit');
    expect(run('--print-current')).toBe('1.0.0');
    expect(run()).toBe('1.0.1');
    git('tag', 'v1.2.3');
    git('tag', 'v1.10.0');
    git('tag', 'v1.2.3-rc1');
    git('tag', 'nightly');
    expect(run('--print-current')).toBe('1.10.0');
    expect(run('--tagged')).toBe('1.10.0');
    expect(run()).toBe('1.10.0');
    git('commit', '-q', '--allow-empty', '-m', 'feat(site): one more');
    expect(run('--tagged')).toBe('');
    expect(run()).toBe('1.11.0');
    expect(run('fix: other')).toBe('1.10.1');
    git('commit', '-q', '--allow-empty', '-m', 'fix: a', '-m', 'BREAKING CHANGE: b');
    expect(run()).toBe('2.0.0');
  });
});
