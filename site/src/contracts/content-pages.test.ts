import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';

import { ABOUT_PATH, DATA_PATH, METHODOLOGY_PATH, fillSections } from '../lib/article-pages';
import aboutPage from '../pages/about.astro';
import dataPage from '../pages/data.astro';
import methodologyPage from '../pages/methodology.astro';
import { getAbout, getDataPage, getMethodology, getSite } from '../lib/content';
import { termsSchema } from '../lib/content-schema';
import { readCredits } from '../lib/credits';
import { decode, pageStrings, readContent, replacedTerms } from '../lib/content-files';
import { formatDate, formatNotPublished } from '../lib/format';
import { isBuilt } from '../lib/links';
import {
  BORDER_COUNT,
  BORDER_RADIUS_KM,
  CHANGE_COUNT,
  LONGEST_COUNT,
  MOVE_VOLUME_FLOOR,
} from '../lib/longest-page';
import { surgeryStamp } from '../lib/index-pages';
import { fill } from '../lib/slots';
import rules from '../lib/pipeline-rules.json';
import { MAX_SPREAD_KM, MIN_PLACE_PAGES, NEAR_RADIUS_KM } from '../lib/surgery-page';
import { render, text, textsOf } from '../lib/test-render';

const methodology = getMethodology();
const sectionText = (id: string): string => {
  const found = methodology.sections.find((s) => s.id === id);
  if (found === undefined) {
    throw new RangeError(`no section ${id}`);
  }
  const [filled] = fillSections([found]);
  return [...(filled?.paragraphs ?? []), ...(filled?.items ?? [])].join(' ');
};

const methodologyHtml = await render(methodologyPage, {});
const dataHtml = await render(dataPage, {});
const aboutHtml = await render(aboutPage, {});
const pages = [
  { path: METHODOLOGY_PATH, html: methodologyHtml, ...methodology },
  { path: DATA_PATH, html: dataHtml, ...getDataPage() },
  { path: ABOUT_PATH, html: aboutHtml, ...getAbout() },
];

function hrefs(html: string): string[] {
  const out: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
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

describe('Content pages', () => {
  it('have one h1, a canonical address, a description and a breadcrumb back to the home page', () => {
    for (const { path, html, heading, crumb } of pages) {
      expect(html.match(/<h1[ >]/g), path).toHaveLength(1);
      expect(html).toContain(`<link rel="canonical" href="${getSite().url}${path.slice(1)}">`);
      expect(html).toContain('<meta name="description" content="');
      expect(text(html.split('<main')[1] ?? html)).toContain(heading);
      expect(textsOf(html, 'c-breadcrumbs__item')).toEqual(['Home', crumb]);
    }
  });

  it('link only to pages that are built', () => {
    for (const { path, html } of pages) {
      const internal = hrefs(html).filter((h) => h.startsWith('/') && !h.startsWith('//'));
      expect(internal.length, path).toBeGreaterThan(0);
      for (const href of internal) {
        expect([path, href, isBuilt(href) || href === '/' || href.startsWith('#')]).toEqual([
          path,
          href,
          true,
        ]);
      }
    }
  });

  it('ship no script and give every section an id its heading points at', () => {
    for (const { html } of pages) {
      expect(html).not.toContain('<script');
      for (const [, id = ''] of html.matchAll(/<section id="([^"]+)" aria-labelledby="([^"]+)"/g)) {
        expect(html).toContain(`id="${id}-heading"`);
      }
    }
  });

  it('use the word elective on the methodology page and in quoted source titles only', () => {
    const { terms, quotes } = termsSchema.parse(
      readContent().find(({ path }) => path === 'terms.yaml')?.data,
    );
    const quoted = (slug: string): { terms: typeof terms; quotes: typeof quotes } => ({
      terms,
      quotes: quotes.filter((q) => q.page === slug),
    });
    expect(pageStrings(methodologyHtml).some((t) => /elective/i.test(t))).toBe(true);
    expect(
      replacedTerms('methodology', pageStrings(methodologyHtml), quoted('methodology')),
    ).toEqual([]);
    expect(replacedTerms('about', pageStrings(aboutHtml), quoted('about'))).toEqual([]);
    // Each place the data page says elective is a title or citation copied from a publisher.
    const sourceText = readCredits().flatMap((c) => [c.title, c.citation].map(decode));
    const onData = pageStrings(dataHtml).filter((t) => /elective/i.test(t));
    for (const found of onData) {
      expect(
        sourceText.some((source) => source.includes(decode(found))),
        found,
      ).toBe(true);
    }
    expect(replacedTerms('data', pageStrings(dataHtml), quoted('data'))).toEqual([]);
    expect(replacedTerms('data', pageStrings(dataHtml), quoted('about')).length > 0).toBe(
      onData.length > 0,
    );
  });

  it('state the private hospital exclusion', () => {
    expect(sectionText('exclusions')).toContain('Private hospitals are excluded');
    expect(text(dataHtml)).toContain('excludes private hospitals');
  });
});

describe('Methodology copy', () => {
  const all = (): string => methodology.sections.map((x) => sectionText(x.id)).join(' ');

  it('fills every slot, so no brace reaches a reader', () => {
    expect(all()).not.toMatch(/[{}]/);
    expect(text(methodologyHtml)).not.toMatch(/[{}]/);
  });

  it('states the figures the code exports', () => {
    expect(sectionText('nearby')).toContain(
      `${String(rules.neighbours)} nearest open public hospitals`,
    );
    expect(sectionText('places')).toContain(
      `within ${String(NEAR_RADIUS_KM)} km of the main hospital`,
    );
    expect(sectionText('places')).toContain(`more than ${String(MAX_SPREAD_KM)} km apart`);
    expect(sectionText('place-pages')).toContain(`at least ${String(MIN_PLACE_PAGES)} surgeries`);
    expect(sectionText('longest')).toContain(`holds the ${String(LONGEST_COUNT)} longest medians`);
    expect(sectionText('longest')).toContain(`within ${String(BORDER_RADIUS_KM)} km of each other`);
    expect(sectionText('longest')).toContain(
      `ranks the ${String(BORDER_COUNT)} largest differences`,
    );
    expect(sectionText('longest')).toContain(
      `the ${String(CHANGE_COUNT)} biggest rises or the ${String(CHANGE_COUNT)} biggest falls`,
    );
    expect(sectionText('longest')).toContain(`at least ${String(MOVE_VOLUME_FLOOR)} surgeries`);
  });

  it('gives each withheld-figure code the wording the site shows for it', () => {
    const copy = sectionText('not-published');
    for (const [marker, reason] of Object.entries(rules.withheld_codes)) {
      expect(copy).toContain(`"${marker}"`);
      expect(copy).toContain(
        formatNotPublished(reason as Parameters<typeof formatNotPublished>[0]),
      );
    }
    expect(sectionText('queensland')).toContain(
      formatNotPublished('not_given_by_queensland_health'),
    );
  });

  it('names the four measures as the pipeline pins them', () => {
    const copy = sectionText('measures');
    expect(Object.keys(rules.measures)).toHaveLength(4);
    for (const name of Object.values(rules.measures)) {
      expect(copy, name).toContain(name);
    }
    expect(rules.measures.long_wait).toContain('longer than 365 days');
  });

  it('describes the rank order the pipeline pins', () => {
    const copy = sectionText('ranks');
    expect(rules.lower_is_better).toEqual({
      median_wait: true,
      long_wait: true,
      on_time: false,
      volume: null,
    });
    expect(copy).toContain('A lower median wait ranks first');
    expect(copy).toContain(
      'A higher share of patients treated within the recommended time ranks first',
    );
    expect(copy).toContain('rank 2nd and the next hospital ranks 4th');
  });

  it('explains the median, the specialty figure and planned surgery', () => {
    expect(sectionText('median')).toContain('Half of the patients waited less than the median');
    expect(sectionText('median')).toContain('A specialty figure covers many operations');
    expect(sectionText('terms')).toContain('Planned surgery is still necessary surgery');
  });
});

describe('Data page', () => {
  const credits = readCredits();
  const passport = dataHtml.split('class="c-passport"')[1] ?? '';

  it('credits every dataset in the dist once, in the data passport', () => {
    expect(credits.length).toBeGreaterThan(0);
    expect(dataHtml.match(/c-passport__source/g)).toHaveLength(credits.length);
    expect(dataHtml.match(/class="c-passport"/g)).toHaveLength(1);
  });

  it('shows the title, publisher, version, licence and citation of each dataset', () => {
    const plain = text(passport);
    for (const credit of credits) {
      expect(plain, credit.slug).toContain(credit.title);
      expect(plain, credit.slug).toContain(credit.publisher.name);
      expect(plain, credit.slug).toContain(formatDate(credit.version));
      expect(plain, credit.slug).toContain(credit.citation);
      expect(passport, credit.slug).toContain(`href="${credit.dataset_url}"`);
    }
  });

  it('states the period and release of the national tables and the counts', () => {
    const body = text(dataHtml.split('<main')[1] ?? dataHtml);
    expect(body).toContain(fill(getDataPage().stamp, surgeryStamp()));
    expect(body).toMatch(/public hospitals, and the site covers [\d,]+ surgeries and specialties/);
  });

  it('credits the typeface the site ships under its licence', () => {
    const body = text(dataHtml.split('<main')[1] ?? dataHtml);
    expect(body).toContain('Newsreader');
    expect(body).toContain('SIL Open Font License, Version 1.1');
    expect(body).toContain('copyright 2020 The Newsreader Project Authors');
  });
});
