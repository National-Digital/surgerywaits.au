import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CEILING_BYTES,
  homeScriptProblems,
  measurePages,
  overBudget,
  overScript,
  scriptWeight,
} from './page-weight.ts';
import type { Budget } from './page-weight.ts';

// Each case is proven on a page built to fail it; the budget here is small so the fixtures stay small.
const fixtures = resolve(import.meta.dirname, 'weight-fixtures');
const budget: Budget = { documentBytes: 1000, pageBytes: 5000, scriptBytes: 1000 };
const problems = async (dir: string): Promise<string[]> =>
  overBudget(await measurePages(resolve(fixtures, dir)), budget);
const command = (...args: string[]): { status: number | null; stdout: string } =>
  spawnSync(process.execPath, ['scripts/weight.ts', ...args], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });

describe('the page-weight gate', () => {
  it('passes a page inside the budget', async () => {
    expect(await problems('light')).toEqual([]);
  });

  it('fails a document over the document budget', async () => {
    const found = await problems('heavy-document');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^\/ document \d+ B, budget 1000 B$/);
  });

  it('counts a stylesheet and the font it loads, and fails a page over the page budget', async () => {
    const [heavy] = await measurePages(resolve(fixtures, 'heavy-assets'));
    expect(heavy?.pageBytes).toBeGreaterThan(8000);
    expect(heavy?.documentBytes).toBeLessThan(1000);
    const found = await problems('heavy-assets');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^\/ page \d+ B, budget 5000 B$/);
  });

  it('measures the script the compare page loads, as built and not the data it fetches', async () => {
    expect(await scriptWeight(resolve(fixtures, 'light'))).toEqual({ file: '/tool.js', bytes: 23 });
    expect(overScript(1000, budget)).toEqual([]);
    expect(overScript(1001, budget)).toEqual(['the tool script is 1001 B, budget 1000 B']);
  });

  it('adds the local chunks the script imports statically and leaves a dynamic import out', async () => {
    expect(await scriptWeight(resolve(fixtures, 'split-script'))).toEqual({
      file: '/tool.js',
      bytes: 193,
    });
  });

  it('counts the script in the weight of the compare page and fails one over the script budget', async () => {
    const pages = await measurePages(resolve(fixtures, 'heavy-script'));
    const compare = pages.find((w) => w.page === '/compare/');
    expect(compare?.pageBytes).toBeGreaterThan(compare?.documentBytes ?? 0);
    const file = resolve(fixtures, 'budget.json');
    const r = command(resolve(fixtures, 'heavy-script'), '--budget', file);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL the tool script is \d+ B, budget 1000 B/);
  });

  it('requires the home page to load the same script file as the compare page', async () => {
    expect(await homeScriptProblems(resolve(fixtures, 'light'))).toEqual([]);
    expect(await homeScriptProblems(resolve(fixtures, 'other-home'))).toEqual([
      'the home page loads other.js and the compare page loads tool.js',
    ]);
    const r = command(
      resolve(fixtures, 'other-home'),
      '--budget',
      resolve(fixtures, 'budget.json'),
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL the home page loads');
  });

  it('fails when neither page loads a script, and when only one does', async () => {
    expect(await homeScriptProblems(resolve(fixtures, 'no-script'))).toEqual([
      'the home page loads no script and the compare page loads no script',
    ]);
    expect(await homeScriptProblems(resolve(fixtures, 'one-script'))).toEqual([
      'the home page loads tool.js and the compare page loads no script',
    ]);
  });

  it('fails when the build has no home page at its root', async () => {
    expect(await homeScriptProblems(resolve(fixtures, 'split-script'))).toEqual([
      'the build has no home page at its root',
    ]);
  });

  it('refuses a script budget above the earlier tool weight', () => {
    expect(overScript(1, { ...budget, scriptBytes: CEILING_BYTES + 1 })[0]).toContain('ceiling');
  });

  it('fails from the command on a heavy page and passes on a light one', () => {
    const file = resolve(fixtures, 'budget.json');
    expect(command(resolve(fixtures, 'heavy-assets'), '--budget', file).status).toBe(1);
    expect(command(resolve(fixtures, 'light'), '--budget', file).status).toBe(0);
  });

  it('fails when no page was measured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weight-'));
    try {
      const r = command(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('no built pages');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('keeps a budget that is a positive whole number of bytes for each measure', async () => {
    const real = JSON.parse(
      await readFile(new URL('./page-weight-budget.json', import.meta.url), 'utf8'),
    ) as Budget;
    expect(Object.keys(real).sort()).toEqual(['documentBytes', 'pageBytes', 'scriptBytes']);
    for (const bytes of Object.values(real)) {
      expect(Number.isInteger(bytes) && bytes > 0).toBe(true);
    }
    expect(real.pageBytes).toBeGreaterThanOrEqual(real.documentBytes);
    expect(real.scriptBytes).toBeLessThanOrEqual(CEILING_BYTES);
  });
});
