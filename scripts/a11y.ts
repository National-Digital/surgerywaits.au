// Usage: node scripts/a11y.ts [<dist> [path ...]]
// With a directory, every page is held to WCAG 2.2 AAA at desktop width and at 390px, in light
// and dark. With none, the fixture pages run instead, and every check must fire on the page built
// to fail it.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CLEAN_FIXTURE,
  PROOF,
  SCHEMES,
  VIEWPORTS,
  auditPage,
  launch,
  serve,
} from './a11y-audit.ts';
import type { Finding } from './a11y-audit.ts';
import { unusedExceptions } from './a11y-checks.ts';
import type { Exception } from './a11y-checks.ts';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
// The override lets the end-to-end test hand the runner an exception that matches nothing.
const override = process.env['A11Y_EXCEPTIONS'];
if (override !== undefined && process.env['A11Y_TEST'] !== '1') {
  throw new Error('A11Y_EXCEPTIONS is for the test run only; set A11Y_TEST=1 with it');
}
const exceptionsFile = override ?? new URL('./a11y-exceptions.json', import.meta.url);
const exceptions = JSON.parse(await readFile(exceptionsFile, 'utf8')) as Exception[];
const [dist, ...paths] = process.argv.slice(2);
let failed = 0;

const show = (findings: Finding[]): void => {
  for (const f of findings) {
    out(`  ${f.rule}`);
    for (const l of f.lines) {
      out(`    ${l}`);
    }
  }
};

async function pages(root: string, list: string[]): Promise<void> {
  const server = await serve(root);
  const browser = await launch();
  const used = new Set<Exception>();
  try {
    for (const scheme of SCHEMES) {
      for (const viewport of VIEWPORTS) {
        for (const path of list) {
          const findings = await auditPage({
            browser,
            base: server.base,
            path,
            scheme,
            viewport,
            exceptions,
            used,
          });
          const tag = `${path} (${scheme}, ${viewport.name})`;
          if (!findings.length) {
            out(`ok   ${tag}`);
            continue;
          }
          failed++;
          out(`FAIL ${tag}: ${String(findings.length)} finding(s)`);
          show(findings);
        }
      }
    }
    if (!paths.length) {
      for (const e of unusedExceptions(exceptions, used)) {
        failed++;
        out(
          `FAIL exception for ${e.rule} within ${e.within} on ${e.pages} matched nothing; remove it`,
        );
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

async function fixtures(): Promise<void> {
  const root = resolve(import.meta.dirname, 'a11y-fixtures');
  const server = await serve(root);
  const browser = await launch();
  try {
    for (const p of PROOF) {
      const where: string[] = [];
      for (const scheme of p.schemes ?? SCHEMES) {
        for (const viewport of VIEWPORTS) {
          const findings = await auditPage({
            browser,
            base: server.base,
            path: `/${p.fixture}`,
            scheme,
            viewport,
            exceptions: [],
            used: new Set(),
          });
          if (findings.some((f) => f.rule === p.rule)) {
            where.push(`${scheme}/${viewport.name}`);
          }
        }
      }
      if (!where.length) {
        failed++;
      }
      out(
        `${where.length ? 'ok  ' : 'FAIL'} ${p.check} fires on ${p.fixture} (${where.join(', ')})`,
      );
    }
    for (const scheme of SCHEMES) {
      for (const viewport of VIEWPORTS) {
        const findings = await auditPage({
          browser,
          base: server.base,
          path: `/${CLEAN_FIXTURE}`,
          scheme,
          viewport,
          exceptions: [],
          used: new Set(),
        });
        if (findings.length) {
          failed++;
        }
        out(
          `${findings.length ? 'FAIL' : 'ok  '} ${CLEAN_FIXTURE} is clean (${scheme}, ${viewport.name})`,
        );
        show(findings);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

if (dist !== undefined) {
  await pages(resolve(dist), paths.length ? paths : ['/']);
} else {
  await fixtures();
}
process.exit(failed ? 1 : 0);
