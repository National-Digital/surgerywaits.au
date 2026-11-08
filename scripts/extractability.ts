// Usage: node scripts/extractability.ts <dist> [--summary file] [--strict]
// Runs trafilatura and Mozilla Readability over a sample of every template in a built site and holds
// each template to its floors in extractability.json. A floor is raised only by a reviewed change.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  choosePages,
  judge,
  markdown,
  measurePage,
  readability,
  unmatched,
} from './extract-checks.ts';
import type { Config } from './extract-checks.ts';

const args = process.argv.slice(2);
const summaryAt = args.indexOf('--summary');
const summary = summaryAt === -1 ? process.env['GITHUB_STEP_SUMMARY'] : args[summaryAt + 1];
const strict = args.includes('--strict');
const [dist] = args.filter(
  (a, i) => !a.startsWith('--') && (summaryAt === -1 || i !== summaryAt + 1),
);
if (dist === undefined) {
  throw new Error('usage: node scripts/extractability.ts <dist> [--summary file] [--strict]');
}
const root = resolve(dist);

// Exit 2 when the gate itself could not run, so a broken setup is never read as a pass.
const couldNotRun = (message: string): never => {
  process.stderr.write(`extractability gate could not run: ${message}\n`);
  if (summary !== undefined) {
    appendFileSync(
      summary,
      `## Extractability (trafilatura, Readability): could not run\n\n${message}\n`,
    );
  }
  process.exit(2);
};

// The override lets the end-to-end test hand the gate a config that fits its fixture.
const override = process.env['EXTRACT_CONFIG'];
if (override !== undefined && process.env['EXTRACT_TEST'] !== '1') {
  throw new Error('EXTRACT_CONFIG is for the test run only; set EXTRACT_TEST=1 with it');
}
const config = JSON.parse(
  readFileSync(override ?? new URL('./extractability.json', import.meta.url), 'utf8'),
) as Config;
if (!existsSync(root)) {
  couldNotRun(`no built site at ${dist}`);
}
const pathOf = (file: string): string => {
  const rel = `/${relative(root, file)}`;
  return rel.endsWith('/index.html') ? rel.slice(0, -'index.html'.length) : rel;
};
const files = new Map(
  readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => resolve(e.parentPath, e.name))
    .map((file): [string, string] => [pathOf(file), file]),
);
if (files.size === 0) {
  couldNotRun(`no built pages under ${dist}`);
}
const paths = [...files.keys()].sort();
const chosen = choosePages(config, paths);

// The test run may swap the helper for a failing command.
const helper = process.env['EXTRACT_TEST'] === '1' ? process.env['EXTRACT_HELPER'] : undefined;
const [command = 'uv', ...helperArgs] =
  helper === undefined
    ? [
        'uv',
        'run',
        '--locked',
        '--project',
        'pipeline',
        'python',
        'pipeline/scripts/trafilatura_extract.py',
      ]
    : helper.split(' ');
const run = spawnSync(command, helperArgs, {
  cwd: new URL('../', import.meta.url),
  input: JSON.stringify(chosen.map((page) => files.get(page.path))),
  encoding: 'utf8',
  maxBuffer: 1 << 30,
});
if (run.status !== 0) {
  couldNotRun(`trafilatura: ${run.error?.message ?? run.stderr.trim()}`);
}
const trafilatura = JSON.parse(run.stdout) as Record<string, string>;

const results = chosen.map(({ path, template }) => {
  const file = files.get(path) ?? '';
  const html = readFileSync(file, 'utf8');
  const article = readability(html);
  return measurePage(
    html,
    path,
    template,
    {
      trafilatura: trafilatura[file] ?? '',
      readability: article.text,
    },
    config,
  );
});
const report = judge(results, config, strict);
for (const path of unmatched(config, paths)) {
  report.failures.push(
    `${path}: belongs to no template in extractability.json; add one with a floor`,
  );
}
const text = markdown(report);
process.stdout.write(text);
if (summary !== undefined) {
  appendFileSync(summary, text);
}
process.exit(report.failures.length > 0 ? 1 : 0);
