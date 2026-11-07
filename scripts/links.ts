// Usage: node scripts/links.ts <dist> [--external]
// Every internal link and asset on every built page must resolve to a built file or a redirect
// source, every fragment to an id on its page, and nothing may link to this site over http.
// External addresses are listed and held to https, and are never fetched.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkLinks } from './link-checks.ts';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const args = process.argv.slice(2);
const listAll = args.includes('--external');
const [dist] = args.filter((a) => !a.startsWith('--'));
if (dist === undefined) {
  throw new Error('usage: node scripts/links.ts <dist> [--external]');
}
const root = new URL('../', import.meta.url);
const site = await readFile(new URL('site/content/site.yaml', root), 'utf8');
const origin = /^url:\s*(\S+)\s*$/m.exec(site)?.[1];
if (origin === undefined) {
  throw new Error('site/content/site.yaml has no url');
}
const redirectsFile = JSON.parse(await readFile(new URL('data/redirects.json', root), 'utf8')) as {
  redirects: { from: string; to: string }[];
};
const redirects = new Map(redirectsFile.redirects.map((r) => [r.from, r.to]));

const report = await checkLinks(resolve(dist), origin, redirects);
if (report.pages === 0) {
  out(`FAIL no built pages under ${dist}`);
  process.exit(1);
}
for (const p of report.problems.slice(0, 200)) {
  out(`FAIL ${p.page} ${p.url} ${p.why}`);
}
if (report.problems.length > 200) {
  out(`... and ${String(report.problems.length - 200)} more`);
}
const hosts = new Map<string, number>();
for (const [url, pages] of report.external) {
  const h = new URL(url).host;
  hosts.set(h, (hosts.get(h) ?? 0) + pages);
  if (listAll) {
    out(`external ${url} (${String(pages)} page(s))`);
  }
}
for (const [h, n] of [...hosts].sort()) {
  out(`external host ${h}: ${String(n)} link(s)`);
}
out(
  `${String(report.pages)} page(s), ${String(report.internal)} internal link(s), ` +
    `${String(report.external.size)} external address(es), ${String(report.problems.length)} problem(s)`,
);
process.exit(report.problems.length ? 1 : 0);
