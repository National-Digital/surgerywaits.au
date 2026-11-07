import { describe, expect, it } from 'vitest';

import PairPage from '../components/PairPage.astro';
import { getPairTemplate, getSite, label } from '../lib/content';
import { history, loadPair, pairRoutes, shorterNearby } from '../lib/pair-page';
import { formatDays, formatHospitals, formatPeriod, formatRank, formatStamp } from '../lib/format';
import { fill } from '../lib/slots';
import { elementsOf, render, text, textsOf, withoutJsonLd } from '../lib/test-render';

const t = getPairTemplate();
const site = getSite();
const escaped = (value: string): string => value.replaceAll("'", '&#39;');

const pages = await Promise.all(
  pairRoutes().map(async ({ props }) => ({
    ...props,
    pair: loadPair(props.slug, props.surgery),
    html: await render(PairPage, { ...props }),
  })),
);

describe('Pair pages', () => {
  it('render one page for every pair, with the title and canonical from content', () => {
    expect(pages.length).toBeGreaterThan(0);
    for (const { slug, surgery, pair, html } of pages) {
      const names = { hospital: pair.hospital.name, surgery: pair.ref.name };
      expect(html, slug).toContain(
        `<title>${escaped(fill(t.title, { ...names, site: site.name }))}</title>`,
      );
      expect(html, slug).toContain(
        `<link rel="canonical" href="${site.url}hospital/${slug}/${surgery}/">`,
      );
      expect(html.match(/<h1[ >]/g), slug).toHaveLength(1);
      expect(textsOf(html, 'h1'), slug).toEqual([fill(t.heading, names)]);
    }
  });

  it('ask not to be indexed exactly when the pair is thin', () => {
    for (const { slug, surgery, pair, html } of pages) {
      expect([
        slug,
        surgery,
        html.includes('<meta name="robots" content="noindex,follow">'),
      ]).toEqual([slug, surgery, pair.thin]);
    }
    expect(pages.some(({ pair }) => pair.thin)).toBe(true);
    expect(pages.some(({ pair }) => !pair.thin)).toBe(true);
  });

  it('link up to the hospital and the surgery, and trail the same breadcrumbs', () => {
    for (const { slug, pair, html } of pages) {
      expect(html, slug).toContain(`href="/hospital/${slug}/"`);
      expect(html, slug).toContain(`href="/surgery/${pair.ref.urlSlug}/"`);
      expect(textsOf(html, 'c-breadcrumbs__item'), slug).toContain(pair.hospital.name);
    }
  });

  it('carry the exclusion, the safety block, the passport and the compact footer', () => {
    for (const { slug, html } of pages) {
      const main = text(html.split('<main')[1] ?? '');
      expect(main, slug).toContain(t.exclusion);
      expect(html, slug).toContain('id="pair-safety-heading"');
      expect(html.match(/class="c-passport"/g), slug).toHaveLength(1);
    }
    const footer = text(pages[0]?.html.split('<footer')[1] ?? '');
    expect(footer).toContain(label('footer_safety_compact'));
    expect(footer).not.toContain(label('footer_safety_full'));
  });

  it('name each chart on a page differently, so no two share a label', () => {
    for (const { slug, surgery, html } of pages) {
      const captions = textsOf(html, 'c-chart__caption');
      expect([slug, surgery, new Set(captions).size]).toEqual([slug, surgery, captions.length]);
    }
    expect(pages.some(({ html }) => (html.match(/<figure/g) ?? []).length > 1)).toBe(true);
  });

  it('ship no script and no handler', () => {
    for (const { slug, html } of pages) {
      expect(withoutJsonLd(html), slug).not.toMatch(/<script|\son[a-z]+=|javascript:/i);
    }
  });

  it('give every figure a stamp and every table a stated period', () => {
    for (const { slug, html } of pages) {
      expect(textsOf(html, 'c-stamp'), slug).toHaveLength(textsOf(html, 'c-figure').length);
      expect(textsOf(html, 'c-table__stamp'), slug).toHaveLength(
        html.match(/<table[ >]/g)?.length ?? 0,
      );
    }
  });

  it('rank only a published figure, as a rank among hospitals nationally, and never a benchmark', () => {
    let ranks = 0;
    for (const { slug, pair, html } of pages) {
      for (const tile of elementsOf(html, 'c-tiles__tile')) {
        const ranked = tile.inside.has('c-tiles__line');
        expect([slug, tile.text, tile.inside.has('is-not-published') && ranked]).toEqual([
          slug,
          tile.text,
          false,
        ]);
        ranks += ranked ? 1 : 0;
      }
      for (const cell of elementsOf(html, 'td')) {
        expect([slug, cell.inside.has('c-table__rank')]).toEqual([slug, false]);
      }
      const measure = pair.row.measures.median_wait;
      if (measure?.rank.status === 'ranked' && measure.figure.state === 'published') {
        expect(html, slug).toContain(
          `${formatRank(measure.rank.position, measure.rank.of)} nationally`,
        );
      }
    }
    expect(ranks).toBeGreaterThan(0);
  });

  it('say the ranking basis and show a not published reason for a withheld median', () => {
    for (const { slug, pair, html } of pages) {
      expect(text(html.split('<main')[1] ?? ''), slug).toContain(t.ranking);
      if (pair.row.measures.median_wait?.figure.state !== 'published') {
        expect(text(html), slug).toContain(
          fill(t.figures_none, {
            hospital: pair.hospital.name,
            surgery: pair.ref.name,
            period: pair.surgery.period,
          }),
        );
      }
    }
  });

  it('list the shorter waits nearby and the hospital history, each figure stamped', () => {
    let listed = 0;
    let told = 0;
    for (const { slug, pair, html } of pages) {
      const shorter = shorterNearby(pair);
      const earlier = history(pair);
      expect(html.includes('id="nearby-heading"'), slug).toBe(shorter !== null);
      expect(html.includes('id="history-heading"'), slug).toBe(earlier !== null);
      const count = formatHospitals(pair.hospital.nearby?.hospitals.length ?? 0);
      if (shorter !== null) {
        expect(text(html), slug).toContain(
          shorter.length > 0
            ? fill(t.nearby_intro, { hospital: pair.hospital.name, surgery: pair.ref.name, count })
            : fill(t.nearby_none, {
                hospital: pair.hospital.name,
                surgery: pair.ref.name,
                period: pair.surgery.period,
                count,
              }),
        );
      }
      for (const near of shorter ?? []) {
        expect(html, slug).toContain(`href="${near.href}"`);
        expect(html, slug).toContain(near.name);
      }
      if (earlier !== null) {
        expect(text(html), slug).toContain(
          `${formatDays(earlier.from.value)} in ${formatPeriod(earlier.from.period)}`,
        );
        expect(text(html), slug).toContain(
          `${formatDays(earlier.to.value)} in ${formatPeriod(earlier.to.period)}`,
        );
        expect(text(html), slug).toContain(`from ${formatStamp(earlier.from)}`);
        expect(text(html), slug).toContain(`from ${formatStamp(earlier.to)}`);
      }
      listed += shorter?.length ?? 0;
      told += earlier === null ? 0 : 1;
    }
    expect(listed).toBeGreaterThan(0);
    expect(told).toBeGreaterThan(0);
  });

  it('say every rank is national', () => {
    for (const { slug, html } of pages) {
      for (const rank of textsOf(html, 'c-tiles__line').filter((t) => t.startsWith('Rank'))) {
        expect(rank, slug).toMatch(/ nationally$/);
      }
    }
  });
});
