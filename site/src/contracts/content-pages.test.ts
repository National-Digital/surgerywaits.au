import { readFileSync } from 'node:fs';
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';

import { ABOUT_PATH, DATA_PATH, METHODOLOGY_PATH } from '../lib/article-pages';
import aboutPage from '../pages/about.astro';
import dataPage from '../pages/data.astro';
import methodologyPage from '../pages/methodology.astro';
import { getAbout, getDataPage, getMethodology, getSite } from '../lib/content';
import { readCredits } from '../lib/credits';
import { pageStrings } from '../lib/content-files';
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
import { render, text, textsOf } from '../lib/test-render';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const pipeline = (file: string): string => read(`../../../pipeline/src/surgerywaits/${file}`);
const library = (file: string): string => read(`../lib/${file}`);

// The number a source file gives a named constant, so the copy is held to the code.
function constant(source: string, name: string): string {
  const found = new RegExp(`^(?:export )?(?:const )?${name}(?::[^=]+)? = ([0-9.]+)`, 'm').exec(
    source,
  );
  if (found?.[1] === undefined) {
    throw new RangeError(`no number named ${name}`);
  }
  return String(Number(found[1]));
}

const methodology = getMethodology();
const sectionText = (id: string): string => {
  const found = methodology.sections.find((s) => s.id === id);
  if (found === undefined) {
    throw new RangeError(`no section ${id}`);
  }
  return [...found.paragraphs, ...(found.items ?? [])].join(' ');
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

  it('use the word elective only on the methodology page', () => {
    expect(pageStrings(methodologyHtml).some((t) => /elective/i.test(t))).toBe(true);
    expect(pageStrings(dataHtml, true).some((t) => /elective/i.test(t))).toBe(false);
    expect(pageStrings(aboutHtml).some((t) => /elective/i.test(t))).toBe(false);
  });

  it('state the private hospital exclusion', () => {
    expect(sectionText('exclusions')).toContain('Private hospitals are excluded');
    expect(text(dataHtml)).toContain('excludes private hospitals');
  });
});

describe('Methodology numbers', () => {
  const nearby = pipeline('nearby.py');
  const places = library('surgery-page.ts');

  it('states the number of nearby hospitals and the search radius the pipeline uses', () => {
    const copy = sectionText('nearby');
    expect(copy).toContain(`${constant(nearby, 'NEIGHBOURS')} nearest open public hospitals`);
    expect(copy).toContain(`starts at ${constant(nearby, 'START_RADIUS_KM')} km`);
    expect(copy).toContain(`until ${constant(nearby, 'NEIGHBOURS')} open hospitals`);
    expect(nearby).toContain('radius * 2');
    expect(nearby).toContain('distance_km(origin, p)');
    expect(nearby).toContain('round(d)');
  });

  it('states the radius, spread and page counts the nearby places use', () => {
    const copy = sectionText('places');
    const radius = constant(places, 'NEAR_RADIUS_KM');
    expect(copy).toContain(`within ${radius} km of the main hospital`);
    expect(copy).toContain(`within ${radius} km of a listed hospital`);
    expect(copy).toContain(`up to ${constant(places, 'MAX_OUTSIDE')} hospitals`);
    expect(copy).toContain(`more than ${constant(places, 'MAX_SPREAD_KM')} km apart`);
    expect(copy).toContain(`at least ${constant(places, 'MIN_RANKED')} hospitals`);
    expect(copy).toContain(`at least ${constant(places, 'MIN_PLACE_PAGES')} surgeries`);
  });

  it('states the freshness limits the build enforces', () => {
    const gates = pipeline('gates.py');
    const copy = sectionText('freshness');
    expect(copy).toContain(`more than ${constant(gates, 'MAX_PERIOD_AGE_YEARS')} years before`);
    expect(copy).toContain(`more than ${constant(gates, 'MAX_QLD_LAG_DAYS')} days after`);
  });

  it('names the four measures as AIHW does, with the long wait threshold the pipeline checks', () => {
    const catalogue = pipeline('catalogue.py');
    const names = [...catalogue.matchAll(/Expected\(\s*Role\.[A-Z_]+,\s*"([^"]+)"/g)].map(
      (m) => m[1] ?? '',
    );
    expect(names).toHaveLength(4);
    const copy = sectionText('measures');
    for (const name of names) {
      expect(copy, name).toContain(name);
    }
    expect(copy).toContain('longer than 365 days');
    expect(names.some((n) => n.includes('longer than 365 days'))).toBe(true);
  });

  it('gives each withheld-figure code the wording the site shows for it', () => {
    const copy = sectionText('not-published');
    const codes = pipeline('suppression.py');
    for (const [marker, reason] of [
      ['<5', 'too_few_patients'],
      ['-', 'no_patients_reported'],
      ['NP', 'not_published_by_aihw'],
      ['Not peered', 'no_peer_group_comparison'],
    ] as const) {
      expect(codes).toContain(`"${marker}": Reason.`);
      expect(copy).toContain(`"${marker}"`);
      expect(copy).toContain(
        formatNotPublished(reason as Parameters<typeof formatNotPublished>[0]),
      );
    }
    expect(sectionText('queensland')).toContain(
      formatNotPublished('not_given_by_queensland_health'),
    );
  });

  it('describes the rank rules the pipeline applies', () => {
    const derive = pipeline('derive.py');
    const copy = sectionText('ranks');
    expect(derive).toContain('Role.MEDIAN_WAIT: True');
    expect(derive).toContain('Role.LONG_WAIT: True');
    expect(derive).toContain('Role.ON_TIME: False');
    expect(derive).toContain('Role.VOLUME: None');
    expect(copy).toContain('rank 2nd and the next hospital ranks 4th');
    for (const blocked of ['not published', 'not reported', 'earlier period', 'closed']) {
      expect(copy).toContain(blocked);
    }
  });

  it('names the four matched Queensland facilities the pipeline lists', () => {
    const queensland = pipeline('queensland.py');
    const overrides = queensland.split('OVERRIDES')[1]?.split('\n}\n')[0] ?? '';
    expect([...overrides.matchAll(/Override\(/g)]).toHaveLength(4);
    expect(sectionText('queensland')).toContain('four named facilities');
  });
});

describe('Methodology longest waits numbers', () => {
  const code = library('longest-page.ts');
  const copy = sectionText('longest');

  it('states the list sizes, radius and volume floor the pages use', () => {
    expect(copy).toContain(`holds the ${String(LONGEST_COUNT)} longest medians`);
    expect(copy).toContain(`within ${String(BORDER_RADIUS_KM)} km of each other`);
    expect(copy).toContain(`ranks the ${String(BORDER_COUNT)} largest differences`);
    expect(copy).toContain(
      `the ${String(CHANGE_COUNT)} biggest rises or the ${String(CHANGE_COUNT)} biggest falls`,
    );
    expect(copy).toContain(`at least ${String(MOVE_VOLUME_FLOOR)} surgeries`);
  });

  it('describes the rules the code applies', () => {
    expect(code).toContain('entries.length < 2');
    expect(copy).toContain('at least 2 hospitals');
    expect(code).toContain('km <= BORDER_RADIUS_KM');
    expect(code).toContain('a.state === b.state');
    expect(code).toContain('distanceKm(a, b)');
    expect(code).toContain('difference <= 0');
    expect(code).toContain('now[0] !== before[0] + 1');
    expect(code).toContain('volume.value < MOVE_VOLUME_FLOOR');
    expect(code).toContain('key(item) === edge');
    expect(code).toContain('!h.closed');
    expect(code).toContain('isCurrent(row, surgery)');
    expect(code).toContain("figure?.state === 'published'");
    expect(code).toContain("ref.kind === 'procedure'");
    for (const rule of ['ties the last row shown', 'closed hospitals', 'earlier period']) {
      expect(copy).toContain(rule);
    }
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
});
