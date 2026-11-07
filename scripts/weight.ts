// Usage: node scripts/weight.ts <dist> [--budget <file>]
// Every built page must stay within the budget in page-weight-budget.json, measured as compressed
// bytes: the document alone and the document with every local file it loads.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { measurePages, overBudget } from './page-weight.ts';
import type { Budget } from './page-weight.ts';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const args = process.argv.slice(2);
const at = args.indexOf('--budget');
const budgetFile =
  at >= 0 ? resolve(args[at + 1] ?? '') : new URL('./page-weight-budget.json', import.meta.url);
const [dist] = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
if (dist === undefined) {
  throw new Error('usage: node scripts/weight.ts <dist> [--budget <file>]');
}
const budget = JSON.parse(await readFile(budgetFile, 'utf8')) as Budget;
for (const key of ['documentBytes', 'pageBytes'] as const) {
  if (!Number.isInteger(budget[key]) || budget[key] <= 0) {
    throw new Error(`the budget needs a positive whole ${key}`);
  }
}
const weights = await measurePages(resolve(dist));
if (weights.length === 0) {
  out(`FAIL no built pages under ${dist}`);
  process.exit(1);
}
const problems = overBudget(weights, budget);
for (const p of problems.slice(0, 200)) {
  out(`FAIL ${p}`);
}
const max = (key: 'documentBytes' | 'pageBytes'): number => Math.max(...weights.map((w) => w[key]));
out(
  `${String(weights.length)} page(s), largest document ${String(max('documentBytes'))} B of ${String(budget.documentBytes)} B, ` +
    `largest page ${String(max('pageBytes'))} B of ${String(budget.pageBytes)} B, ${String(problems.length)} over budget`,
);
process.exit(problems.length ? 1 : 0);
