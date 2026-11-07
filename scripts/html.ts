// Usage: node scripts/html.ts <dist>
// Runs the W3C Nu Html Checker over every HTML file under <dist>. Any error or warning fails.
// The checker needs Java on PATH, or named in JAVA.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [dist] = process.argv.slice(2);
if (dist === undefined) {
  throw new Error('usage: node scripts/html.ts <dist>');
}
const root = new URL('../', import.meta.url).pathname;
const result = spawnSync(
  process.env['JAVA'] ?? 'java',
  [
    '-jar',
    resolve(root, 'node_modules/vnu-jar/build/dist/vnu.jar'),
    '--skip-non-html',
    '--Werror',
    '--filterfile',
    resolve(root, 'docs/refs/policies/html-validate-filters.txt'),
    resolve(dist),
  ],
  { stdio: 'inherit' },
);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
