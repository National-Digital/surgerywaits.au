import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import page from '../pages/hospital/[slug]/index.astro';
import { getHospitalTemplate, getSite } from '../lib/content';
import { hospitalTemplateSchema } from '../lib/content-schema';
import { readContent } from '../lib/content-files';
import { DIST_ENV, distDirectory, listDist, readHospital } from '../lib/dist';
import { fill } from '../lib/slots';
import { elementsOf, render, text, textsOf, withoutJsonLd } from '../lib/test-render';

const t = getHospitalTemplate();
const slugs = listDist('hospitals');
const rendered = new Map<string, string>();

async function build(slug: string): Promise<string> {
  const cached = rendered.get(slug);
  if (cached !== undefined) {
    return cached;
  }
  const html = await render(page, { slug });
  rendered.set(slug, html);
  return html;
}

const copies: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  rendered.clear();
  for (const copy of copies.splice(0)) {
    rmSync(copy, { recursive: true, force: true });
  }
});

// A copy of the fixture dist with one hospital file changed, so the original is never touched.
function changed(slug: string, change: (hospital: Record<string, unknown>) => void): void {
  const copy = mkdtempSync(join(tmpdir(), 'dist-'));
  copies.push(copy);
  cpSync(distDirectory(), copy, { recursive: true });
  const file = join(copy, `hospitals/${slug}.json`);
  const hospital = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  change(hospital);
  writeFileSync(file, JSON.stringify(hospital));
  vi.stubEnv(DIST_ENV, copy);
}

describe('Hospital page', () => {
  it('builds for every fixture hospital, open and closed', async () => {
    expect(slugs.length).toBeGreaterThan(10);
    expect(slugs.some((s) => readHospital(s).closed)).toBe(true);
    expect(slugs.some((s) => !readHospital(s).closed)).toBe(true);
    for (const slug of slugs) {
      const hospital = readHospital(slug);
      const html = await build(slug);
      expect(html, slug).toContain(
        `<title>${fill(hospital.closed ? t.title_closed : t.title, { hospital: hospital.name, site: getSite().name }).replaceAll("'", '&#39;')}</title>`,
      );
      expect(html, slug).toContain(
        `<link rel="canonical" href="${getSite().url}hospital/${slug}/">`,
      );
      expect(html, slug).toContain('<meta name="description" content="');
      expect(textsOf(html, 'c-about__heading'), slug).toEqual([t.about_heading]);
      expect(html.match(/<h1[ >]/g), slug).toHaveLength(1);
    }
  }, 60_000);

  it('takes the title and description from the content templates', async () => {
    const hospital = readHospital('wollongong-hospital');
    const html = await build('wollongong-hospital');
    const description = fill(t.description, {
      hospital: hospital.name,
      state: t.states[hospital.state],
      period: '2024–25',
    });
    expect(html).toContain(`<meta name="description" content="${description}">`);
  });

  it('shows the about card with state, network, status and other names', async () => {
    const html = await build('wollongong-hospital');
    const card = elementsOf(html, 'c-about')[0]?.text ?? '';
    for (const part of [
      t.about_heading,
      t.states.NSW,
      'Illawarra Shoalhaven',
      t.status_open,
      t.about_names,
      'Wollongong',
    ]) {
      expect(card).toContain(part);
    }
    const none = await build('mater-adult-hospital');
    expect(elementsOf(none, 'c-about')[0]?.text).toContain(t.network_none);
  });

  it('ships the sections the page needs and no script', async () => {
    const html = await build('wollongong-hospital');
    expect(withoutJsonLd(html)).not.toContain('<script');
    for (const cls of [
      'c-breadcrumbs',
      'c-tiles',
      'c-table',
      'c-chart',
      'c-nearby',
      'c-safety',
      'c-passport',
    ]) {
      expect(elementsOf(html, cls).length, cls).toBeGreaterThan(0);
    }
    expect(textsOf(html, 'c-nearby__name')).toContain('Bulli Hospital');
    expect(html).toContain('href="/hospital/bulli-hospital/"');
  });
});

describe('Hospital page figures', () => {
  it('state a period and release on every figure, table and chart', async () => {
    let figures = 0;
    for (const slug of slugs) {
      const html = await build(slug);
      const figs = textsOf(html, 'c-figure');
      figures += figs.length;
      expect(textsOf(html, 'c-stamp'), slug).toHaveLength(figs.length);
      for (const stamp of textsOf(html, 'c-stamp')) {
        expect(stamp, slug).toMatch(/released \d{1,2} \w+ \d{4}$/);
      }
      expect(textsOf(html, 'c-table__stamp'), slug).toHaveLength(
        html.match(/<table[ >]/g)?.length ?? 0,
      );
      expect(textsOf(html, 'c-chart__stamp'), slug).toHaveLength(textsOf(html, 'c-chart').length);
    }
    expect(figures).toBeGreaterThan(50);
  }, 60_000);

  it('rank only a current published figure', async () => {
    let ranks = 0;
    for (const slug of slugs) {
      const html = await build(slug);
      for (const tile of elementsOf(html, 'c-tiles__tile')) {
        const ranked = tile.inside.has('c-tiles__line');
        if (tile.classes.has('c-tiles__earlier') || tile.inside.has('is-not-published')) {
          expect(tile.inside.has('c-tiles__line'), `${slug} ${tile.text}`).toBe(false);
        }
        ranks += ranked ? 1 : 0;
      }
      for (const row of elementsOf(html, 'tr')) {
        if (row.classes.has('c-table__row--earlier')) {
          expect(row.inside.has('c-table__rank'), `${slug} ${row.text}`).toBe(false);
        }
      }
      for (const cell of elementsOf(html, 'td')) {
        if (cell.classes.has('is-not-published')) {
          expect(cell.inside.has('c-table__rank'), `${slug} ${cell.text}`).toBe(false);
        }
        ranks += cell.inside.has('c-table__rank') ? 1 : 0;
      }
    }
    expect(ranks).toBeGreaterThan(50);
  }, 60_000);
});

describe('Closed hospital page', () => {
  it('says the hospital has closed and ranks nothing', async () => {
    const hospital = readHospital('manly-hospital');
    expect(hospital.closed).toBe(true);
    const html = await build('manly-hospital');
    expect(html).toContain(
      `<title>${fill(t.title_closed, { hospital: hospital.name, site: getSite().name })}</title>`,
    );
    expect(textsOf(html, 'c-notice__heading')).toEqual([t.closed_heading]);
    expect(elementsOf(html, 'c-notice')[0]?.text).toContain(
      fill(t.closed_notice, { hospital: hospital.name }),
    );
    expect(elementsOf(html, 'c-about')[0]?.text).toContain(t.status_closed);
    expect(text(html)).toContain(t.lede_closed.replace('{state}', t.states.NSW));
    expect(textsOf(html, 'c-tiles__line')).toEqual([]);
    expect(textsOf(html, 'c-table__rank')).toEqual([]);
  });

  it('says so when the source gives no location to find hospitals near it', async () => {
    const html = await build('manly-hospital');
    expect(text(html)).toContain(fill(t.nearby_none, { hospital: 'Manly Hospital' }));
    expect(textsOf(html, 'c-nearby')).toEqual([]);
  });

  it('points to the open hospitals nearby when the hospital has a mesh', async () => {
    changed('wollongong-hospital', (hospital) => {
      hospital['closed'] = true;
    });
    const html = await build('wollongong-hospital');
    expect(textsOf(html, 'c-notice__heading')).toEqual([t.closed_heading]);
    expect(text(html)).toContain(t.nearby_heading_closed);
    expect(text(html)).not.toContain(t.nearby_none.slice(0, 20));
    expect(html).toContain('href="/hospital/bulli-hospital/"');
  });
});

describe('Hospital page with only earlier figures', () => {
  it('says every figure is from an earlier period and shows no rank', async () => {
    const slug = 'north-canberra-hospital-previously-known-as-calvary-public-hospital-bruce';
    const hospital = readHospital(slug);
    expect(hospital.surgeries.every((s) => s.stale)).toBe(true);
    const html = await build(slug);
    expect(textsOf(html, 'c-notice__heading')).toEqual([t.earlier_only_heading]);
    expect(textsOf(html, 'c-tiles__line')).toEqual([]);
    expect(textsOf(html, 'c-table__rank')).toEqual([]);
  });
});

describe('Queensland hospital page', () => {
  it('keeps the quarterly figures apart, stamped and unranked', async () => {
    const html = await build('mater-adult-hospital');
    const heading = textsOf(html, 'c-qld');
    expect(heading).toHaveLength(1);
    expect(text(html)).toContain(t.qld_heading);
    const figures = elementsOf(html, 'c-qld__tile');
    expect(figures).toHaveLength(3);
    for (const tile of figures) {
      expect(tile.inside.has('c-stamp')).toBe(true);
      expect(tile.text).not.toMatch(/Rank/);
    }
  });

  it('shows no Queensland section on a hospital in another state', async () => {
    expect(textsOf(await build('wollongong-hospital'), 'c-qld')).toEqual([]);
  });
});

describe('Hospital template content', () => {
  const file = readContent().find(({ path }) => path === 'templates/hospital.yaml');

  it('fails on a missing or an unknown slot', () => {
    const data = file?.data as Record<string, string>;
    expect(hospitalTemplateSchema.safeParse(data).success).toBe(true);
    expect(hospitalTemplateSchema.safeParse({ ...data, title: '{hospital}' }).success).toBe(false);
    expect(
      hospitalTemplateSchema.safeParse({ ...data, title: '{hospital} {site} {wrong}' }).success,
    ).toBe(false);
    expect(hospitalTemplateSchema.safeParse({ ...data, exclusion: 'Excludes {x}.' }).success).toBe(
      false,
    );
  });

  it('names no urgency category the dist lacks, and every one it has', () => {
    const names = new Set(Object.keys(t.urgency));
    for (const slug of slugs) {
      for (const s of readHospital(slug).surgeries.filter((x) => x.kind === 'urgency')) {
        expect(names.has(s.slug), s.slug).toBe(true);
      }
    }
  });
});
