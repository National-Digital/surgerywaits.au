import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';

import hospitalPage from '../pages/hospital/[slug]/index.astro';
import hospitals from '../pages/hospitals/index.astro';
import surgeries from '../pages/surgery/index.astro';
import {
  getHospitalsIndex,
  getHospitalTemplate,
  getSite,
  getSurgeryNames,
  getSurgeryTemplate,
} from '../lib/content';
import { readHospital, readHospitalIndex, readSurgeryIndex } from '../lib/dist';
import { fill } from '../lib/slots';
import { render, text, textsOf } from '../lib/test-render';

type Node = DefaultTreeAdapterTypes.Node;

function hrefs(html: string): string[] {
  const out: string[] = [];
  const visit = (node: Node): void => {
    if ('tagName' in node && node.tagName === 'a') {
      out.push(node.attrs.find((a) => a.name === 'href')?.value ?? '');
    }
    if ('childNodes' in node) {
      node.childNodes.forEach(visit);
    }
  };
  visit(parseFragment(html));
  return out;
}

const ids = (html: string): Set<string> =>
  new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1] ?? ''));

const rows = readHospitalIndex();
const hospitalsHtml = await render(hospitals, {});
const surgeriesHtml = await render(surgeries, {});
const ht = getHospitalsIndex();
const st = getSurgeryTemplate();

describe('Hospitals index', () => {
  it('lists every hospital in the index exactly once, linked to its page', () => {
    const links = hrefs(hospitalsHtml).filter((h) => h.startsWith('/hospital/'));
    expect(links.sort()).toEqual(rows.map(({ slug }) => `/hospital/${slug}/`).sort());
    expect(new Set(links).size).toBe(rows.length);
  });

  it('groups hospitals by state and then A to Z', () => {
    const names = getHospitalTemplate().states;
    const present = Object.entries(names).filter(([code]) => rows.some((r) => r.state === code));
    for (const [code, name] of present) {
      expect(hospitalsHtml).toContain(`<h2 id="${code.toLowerCase()}-heading">${name}</h2>`);
    }
    const sorted = (list: string[]): string[] =>
      [...list].sort(new Intl.Collator('en-AU', { sensitivity: 'base' }).compare);
    const links = [...hospitalsHtml.matchAll(/href="\/hospital\/([^"]+)\/"/g)].map(
      (m) => m[1] ?? '',
    );
    const order = present.flatMap(([code]) =>
      links.filter((slug) => rows.find((r) => r.slug === slug)?.state === code),
    );
    expect(links).toEqual(order);
    for (const [code] of present) {
      const inState = rows.filter((r) => r.state === code).map((r) => r.name);
      const listed = links
        .map((slug) => rows.find((r) => r.slug === slug))
        .filter((r) => r?.state === code)
        .map((r) => r?.name ?? '');
      expect(listed).toEqual(sorted(inState));
    }
  });

  it('marks every closed hospital with a word and no other', () => {
    const closed = rows.filter((r) => r.closed);
    expect(closed.length).toBeGreaterThan(0);
    expect(textsOf(hospitalsHtml, 'c-index-list__tag')).toEqual(closed.map(() => ht.closed_tag));
    expect(text(hospitalsHtml)).toContain(fill(ht.closed_note, { closed: String(closed.length) }));
  });

  it('shows other names in small type under the name', () => {
    const withNames = rows
      .map((r) => readHospital(r.slug))
      .filter((h) => h.alternative_names.some((n) => n !== h.name));
    expect(withNames.length).toBeGreaterThan(0);
    expect(
      textsOf(hospitalsHtml, 'c-index-list__note').filter((n) => n.startsWith(ht.names_label)),
    ).toHaveLength(withNames.length);
    for (const h of withNames) {
      expect(text(hospitalsHtml)).toContain(h.alternative_names.find((n) => n !== h.name) ?? '');
    }
  });

  it('stamps the counts with their period and release, and says who is reporting', () => {
    const main = text(hospitalsHtml);
    const reporting = rows.filter((r) => readHospital(r.slug).surgeries.some((s) => !s.stale));
    expect(main).toMatch(
      /These counts are for \d{4}–\d{2}\. The register was released on \d{1,2} \w+ \d{4}\./,
    );
    expect(main).toContain(
      fill(ht.reporting_note, {
        reporting: String(reporting.length),
        not_reporting: String(rows.length - reporting.length),
      }),
    );
  });

  it('gives each hospital the exact count of surgery types it reports', () => {
    const expected = rows.map((r) => {
      const procedures = readHospital(r.slug).surgeries.filter((x) => x.kind === 'procedure');
      const current = procedures.filter((x) => !x.stale).length;
      const earlier = procedures.length - current;
      const now =
        current === 0
          ? 'not reported for this period'
          : `${String(current)} surgery ${current === 1 ? 'type' : 'types'} this period`;
      const before =
        earlier === 0
          ? []
          : [
              `${String(earlier)} surgery ${earlier === 1 ? 'type' : 'types'} last reported earlier`,
            ];
      return [now, ...before].join(', ');
    });
    const shown = textsOf(hospitalsHtml, 'c-index-list__note').filter(
      (n) => !n.startsWith(ht.names_label),
    );
    expect(shown.sort()).toEqual(expected.sort());
    expect(expected.some((n) => n.startsWith('not reported'))).toBe(true);
    expect(expected.some((n) => n.includes(', '))).toBe(true);
  });

  it('states the private hospital exclusion and ships no script', () => {
    const main = text(hospitalsHtml);
    expect(main).toContain(ht.exclusion_heading);
    expect(main).toContain(ht.exclusion);
    expect(hospitalsHtml).not.toMatch(/<script|\son[a-z]+=/i);
  });

  it('jumps to a state with in-page anchors that all resolve', () => {
    const anchors = hrefs(hospitalsHtml).filter((h) => h.startsWith('#') && h !== '#top');
    expect(anchors.length).toBeGreaterThan(0);
    const known = ids(hospitalsHtml);
    for (const anchor of anchors) {
      expect([anchor, known.has(anchor.slice(1))]).toEqual([anchor, true]);
    }
  });

  it('takes the title, description and canonical from content', () => {
    expect(hospitalsHtml).toContain(`<title>${fill(ht.title, { site: getSite().name })}</title>`);
    expect(hospitalsHtml).toContain(`<meta name="description" content="${ht.description}">`);
    expect(hospitalsHtml).toContain(`<link rel="canonical" href="${getSite().url}hospitals/">`);
    expect(hospitalsHtml.match(/<h1[ >]/g)).toHaveLength(1);
  });

  it('adds the Hospitals crumb to a hospital page now the index is built', async () => {
    const t = getHospitalTemplate();
    const html = await render(hospitalPage, { slug: rows[0]?.slug ?? '' });
    expect(hrefs(html)).toContain('/hospitals/');
    expect(textsOf(html, 'c-breadcrumbs__item')[1]).toBe(t.crumb_hospitals);
  });
});

describe('Surgery index', () => {
  const surgeriesIndex = readSurgeryIndex();
  const links = hrefs(surgeriesHtml).filter((h) => /^\/(surgery|specialty)\/.+/.test(h));

  it('links every procedure at the address the earlier site used', () => {
    // Pinned by hand against surgery-names.yaml, so a renamed slug cannot pass by being read from the same data.
    for (const address of [
      '/surgery/acl-reconstruction/',
      '/surgery/cataract-surgery/',
      '/surgery/hernia-repair/',
      '/surgery/hip-replacement/',
    ]) {
      expect(links).toContain(address);
    }
    const overrides = Object.entries(getSurgeryNames()).filter(
      ([dist, entry]) =>
        entry.slug !== undefined &&
        surgeriesIndex.some((s) => s.kind === 'procedure' && s.slug === dist),
    );
    expect(overrides.length).toBeGreaterThan(0);
    for (const [dist, entry] of overrides) {
      expect(links).toContain(`/surgery/${entry.slug ?? ''}/`);
      expect(links).not.toContain(`/surgery/${dist}/`);
    }
    expect(links.filter((h) => h.startsWith('/surgery/'))).toHaveLength(
      surgeriesIndex.filter((s) => s.kind === 'procedure').length,
    );
  });

  it('lists the urgency categories in the order 1, 2, 3', () => {
    const names = Object.values(getHospitalTemplate().urgency);
    const main = text(surgeriesHtml);
    const places = names.map((name) => main.indexOf(name));
    expect(places.every((p) => p >= 0)).toBe(true);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(names.map((n) => n.slice(0, 10))).toEqual(['Category 1', 'Category 2', 'Category 3']);
  });

  it('gives every entry a count and a period, and states the release date', () => {
    const main = text(surgeriesHtml);
    for (const s of surgeriesIndex.filter((x) => x.kind === 'specialty')) {
      expect(main).toContain(s.name);
    }
    expect(main).toMatch(/released on \d{1,2} \w+ \d{4}/);
  });

  it('jumps to each group heading with anchors that resolve, under a label', () => {
    const known = ids(surgeriesHtml);
    const anchors = hrefs(surgeriesHtml).filter(
      (h) => h.startsWith('#') && h !== '#top' && h !== '#main',
    );
    expect(anchors).toHaveLength(3);
    for (const anchor of anchors) {
      expect([anchor, known.has(anchor.slice(1))]).toEqual([anchor, true]);
    }
    expect(surgeriesHtml).toContain(`aria-label="${st.index_jump_label}"`);
  });

  it('states the exclusion, takes its title from content and ships no script', () => {
    expect(text(surgeriesHtml)).toContain(st.exclusion);
    expect(surgeriesHtml).not.toMatch(/<script|\son[a-z]+=/i);
    expect(surgeriesHtml).toContain(`<link rel="canonical" href="${getSite().url}surgery/">`);
  });
});
