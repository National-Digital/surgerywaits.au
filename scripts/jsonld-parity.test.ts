import { describe, expect, it } from 'vitest';

import { addressOf, baselineOf, compare, extractNodes, familyOf } from './jsonld-parity.ts';

const origin = 'https://site.test';
const block = (value: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const mapOf = (...nodes: { id: string; type: string }[]): Map<string, Set<string>> =>
  new Map(nodes.map(({ id, type }) => [id, new Set([type])]));

describe('extractNodes', () => {
  it('reads typed nodes with an @id from a graph, a list and a nested value, and skips a bare reference', () => {
    const html =
      block({ '@graph': [{ '@type': 'A', '@id': 'x', part: { '@type': 'B', '@id': 'y' } }] }) +
      block([{ '@type': 'C', '@id': 'z', link: { '@id': 'x' } }, { '@type': 'D' }]);
    expect(extractNodes(html)).toEqual([
      { id: 'x', type: 'A' },
      { id: 'y', type: 'B' },
      { id: 'z', type: 'C' },
    ]);
  });
});

describe('addressOf and familyOf', () => {
  it('turn a built file into its address and a family by depth', () => {
    expect(addressOf('hospital/a/b/index.html')).toBe('/hospital/a/b/');
    expect(addressOf('index.html')).toBe('/');
    expect(addressOf('404.html')).toBe('/404.html');
    expect(familyOf('/hospital/a/b/')).toBe('hospital/*/*');
    expect(familyOf('/')).toBe('');
  });
});

describe('compare', () => {
  const before = mapOf(
    { id: 'https://org.test/#organization', type: 'Organization' },
    { id: `${origin}/a/#webpage`, type: 'WebPage' },
    { id: `${origin}/gone/#webpage`, type: 'WebPage' },
    { id: `${origin}/lost/#webpage`, type: 'WebPage' },
    { id: `${origin}/typed/#webpage`, type: 'MedicalWebPage' },
  );
  const baseline = baselineOf(before, origin, true);

  it('reports a missing id, a retired address that redirects, a changed type and an addition', () => {
    const built = mapOf(
      { id: 'https://org.test/#organization', type: 'Organization' },
      { id: `${origin}/a/#webpage`, type: 'WebPage' },
      { id: `${origin}/typed/#webpage`, type: 'WebPage' },
      { id: `${origin}/new/#webpage`, type: 'WebPage' },
    );
    const report = compare(baseline, built, new Set(['/gone/']));
    expect(report.missing.map((n) => `${n.id} ${n.type}`)).toEqual([
      `${origin}/lost/#webpage WebPage`,
      `${origin}/typed/#webpage MedicalWebPage`,
    ]);
    expect(report.retired.map((n) => n.id)).toEqual([`${origin}/gone/#webpage`]);
    expect(report.added.map((n) => n.id)).toEqual([
      `${origin}/new/#webpage`,
      `${origin}/typed/#webpage`,
    ]);
  });

  it('passes a build that holds every baseline node', () => {
    const report = compare(baseline, before, new Set());
    expect([report.missing, report.retired, report.added, report.shortfalls]).toEqual([
      [],
      [],
      [],
      [],
    ]);
  });

  it('summarises a family past the listing limit by count, and flags a shortfall', () => {
    const many = mapOf(
      ...Array.from({ length: 41 }, (_, i) => ({
        id: `${origin}/h/${String(i)}/#webpage`,
        type: 'WebPage',
      })),
    );
    const summary = baselineOf(many, origin);
    expect(summary.pages).toEqual([]);
    expect(summary.families).toEqual([{ family: 'h/*', types: ['WebPage'], count: 41 }]);
    expect(compare(summary, many, new Set()).shortfalls).toEqual([]);
    expect(compare(summary, mapOf(), new Set(['/h/1/'])).shortfalls).toHaveLength(1);
  });
});
