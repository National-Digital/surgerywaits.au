import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';

import HomePage from '../components/HomePage.astro';
import { getHomeTemplate, getSite } from '../lib/content';
import { readHospitalIndex, readSurgery } from '../lib/dist';
import { COMMON_COUNT } from '../lib/home-page';
import { stateFiles, statePath } from '../lib/state-page';
import { surgeryPath, surgeryRefs } from '../lib/surgery-page';
import { categories } from '../lib/urgency-page';
import { fill } from '../lib/slots';
import { elementsOf, render, text, textsOf } from '../lib/test-render';

const t = getHomeTemplate();
const site = getSite();
const html = await render(HomePage, {});
const main = text(html.split('<main')[1] ?? html);

function hrefs(source: string): string[] {
  const out: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node && node.tagName === 'a') {
      out.push(node.attrs.find((a) => a.name === 'href')?.value ?? '');
    }
    if ('childNodes' in node) {
      node.childNodes.forEach(visit);
    }
  };
  visit(parseFragment(source));
  return out;
}

// Pages that are built, so a link to a page still to come fails here.
const BUILT = new Set(['/surgery/', '/specialty/', '/hospitals/', '/state/', '/urgency/']);

describe('Home page', () => {
  it('has one h1, a title and canonical address from content, and no breadcrumbs', () => {
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="${site.url}">`);
    expect(html).toContain(`<title>${fill(t.title, { site: site.name })}</title>`);
    expect(textsOf(html, 'c-breadcrumbs__item')).toEqual([]);
    expect(main).toContain(t.heading);
  });

  it('links to the index of each way to look, and to each state, category and common surgery', () => {
    const links = hrefs(html);
    for (const index of BUILT) {
      expect(links).toContain(index);
    }
    for (const file of stateFiles()) {
      expect(links).toContain(statePath(file.state));
    }
    for (const category of categories()) {
      expect(links).toContain(category.path);
    }
    const common = links.filter((h) => h.startsWith('/surgery/') && h !== '/surgery/');
    expect(common).toHaveLength(COMMON_COUNT);
  });

  it('links only to pages that are built', () => {
    const built = new Set<string>(BUILT);
    for (const file of stateFiles()) {
      built.add(statePath(file.state));
    }
    for (const category of categories()) {
      built.add(category.path);
    }
    for (const ref of surgeryRefs()) {
      built.add(surgeryPath(ref));
    }
    for (const href of hrefs(html).filter((h) => h.startsWith('/'))) {
      expect([href, built.has(href) || href === '/' || href.startsWith('/#')]).toEqual([
        href,
        true,
      ]);
    }
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    for (const href of hrefs(html).filter((h) => h.startsWith('#'))) {
      expect([href, href === '#top' || ids.has(href.slice(1))]).toEqual([href, true]);
    }
  });

  it('counts what the dist holds', () => {
    expect(main).toContain(
      fill(t.hospitals_note_many, { count: readHospitalIndex().length.toLocaleString('en-AU') }),
    );
    expect(main).toContain(fill(t.states_note_many, { count: String(stateFiles().length) }));
    expect(main).toContain(fill(t.urgency_note_many, { count: String(categories().length) }));
    expect(main).toMatch(/The counts on this page are for \d{4}–\d{2}\. The data was released on/);
  });

  it('orders the common surgeries by patients treated, most first, under one stamp', () => {
    const expected = surgeryRefs()
      .filter((ref) => ref.kind === 'procedure')
      .flatMap((ref) => {
        const volume = readSurgery(ref.kind, ref.slug).benchmarks.national?.volume;
        return volume?.state === 'published' ? [{ ref, value: volume.value }] : [];
      })
      .sort((a, b) => b.value - a.value || (a.ref.urlSlug < b.ref.urlSlug ? -1 : 1))
      .slice(0, COMMON_COUNT)
      .map(({ ref }) => surgeryPath(ref));
    const table = html.split('id="common-caption"')[1]?.split('</table>')[0] ?? '';
    expect([...table.matchAll(/href="(\/surgery\/[^"]+)"/g)].map((m) => m[1])).toEqual(expected);
    expect(expected).toHaveLength(COMMON_COUNT);
    expect(textsOf(html, 'c-table__stamp')).toHaveLength(1);
    expect(textsOf(html, 'c-table__stamp')[0]).toMatch(/\d{4}–\d{2}, released \d{1,2} \w+ \d{4}/);
    expect(textsOf(html, 'c-table__rank')).toEqual([]);
    const volumes = elementsOf(`<table>${table}</table>`, 'td')
      .filter((_, i) => i % 2 === 1)
      .map((cell) => Number(cell.text.replaceAll(/[^\d]/g, '')));
    expect(volumes.every((v) => Number.isInteger(v) && v > 0)).toBe(true);
    expect(volumes).toHaveLength(COMMON_COUNT);
    expect(volumes).toEqual([...volumes].sort((a, b) => b - a));
    expect(html.includes('c-figure')).toBe(false);
  });

  it('states the private hospital exclusion, the safety block once and the passport once', () => {
    expect(main).toContain(t.exclusion);
    expect((html.match(/class="c-passport"/g) ?? []).length).toBe(1);
    expect(html.match(/id="[a-z]+-safety-heading"/g) ?? []).toHaveLength(1);
  });

  it('ships no script and no event handler, and no search or compare control', () => {
    expect(/<script|\son[a-z]+=|javascript:|<form|<input/i.test(html)).toBe(false);
  });
});
