// Usage: node scripts/html.ts <dist>
// Runs the W3C Nu Html Checker over every HTML file under <dist>. Any error or warning fails.
// The checker needs Java on PATH, or named in JAVA.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { unreasonedFilters } from './html-filters.ts';

const [dist] = process.argv.slice(2);
if (dist === undefined) {
  throw new Error('usage: node scripts/html.ts <dist>');
}
const hasHtml = (dir: string): boolean =>
  readdirSync(dir, { withFileTypes: true, recursive: true }).some(
    (e) => e.isFile() && e.name.endsWith('.html'),
  );
if (!hasHtml(resolve(dist))) {
  throw new Error(`no HTML files under ${dist}`);
}
const root = new URL('../', import.meta.url).pathname;
// The override lets the test hand the command a filter file with a line that has no reason.
const override = process.env['HTML_FILTERS'];
if (override !== undefined && process.env['HTML_TEST'] !== '1') {
  throw new Error('HTML_FILTERS is for the test run only; set HTML_TEST=1 with it');
}
const filters = override ?? resolve(root, 'docs/refs/policies/html-validate-filters.txt');
const unreasoned = unreasonedFilters(readFileSync(filters, 'utf8'));
if (unreasoned.length > 0) {
  process.stderr.write(`filter lines with no reason above them:\n${unreasoned.join('\n')}\n`);
  process.exit(1);
}
const result = spawnSync(
  process.env['JAVA'] ?? 'java',
  [
    '-jar',
    resolve(root, 'node_modules/vnu-jar/build/dist/vnu.jar'),
    '--skip-non-html',
    '--Werror',
    '--filterfile',
    filters,
    resolve(dist),
  ],
  { stdio: 'inherit' },
);
if (result.error) {
  process.stderr.write(
    `could not run Java (${process.env['JAVA'] ?? 'java'}): ${result.error.message}. Install Java or set JAVA to its path.\n`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
