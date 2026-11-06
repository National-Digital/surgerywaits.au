import { afterEach, describe, expect, it, vi } from 'vitest';

import SurgeryHub from '../components/SurgeryHub.astro';
import SpecialtyIndex from '../components/SpecialtyIndex.astro';
import SurgeryIndex from '../components/SurgeryIndex.astro';
import SurgeryNear from '../components/SurgeryNear.astro';
import SurgeryState from '../components/SurgeryState.astro';
import { getHospitalTemplate, getSite, getSurgeryTemplate } from '../lib/content';
import { listSurgeries, readSurgery } from '../lib/dist';
import { formatFigure } from '../lib/format';
import { fill } from '../lib/slots';
import {
  hubRoutes,
  nearArea,
  nearPath,
  nearRoutes,
  refOf,
  stateRoutes,
  statePath,
  surgeryPath,
  surgeryRefs,
} from '../lib/surgery-page';
import type { PageKind } from '../lib/surgery-page';
import { cleanUpCopies, withNearbyPair } from '../lib/test-dist';
import { elementsOf, render, text, textsOf } from '../lib/test-render';

const t = getSurgeryTemplate();
const states = getHospitalTemplate().states;
const site = getSite();
const escaped = (value: string): string => value.replaceAll("'", '&#39;');

afterEach(() => {
  vi.unstubAllEnvs();
  cleanUpCopies();
});

// The addresses the earlier site gave, taken from its sitemap, so a renamed slug cannot slip past.
const EARLIER_ADDRESSES = [
  '/surgery/',
  '/surgery/hip-replacement/',
  '/surgery/hip-replacement/nsw/',
  '/surgery/knee-replacement/',
  '/surgery/acl-reconstruction/',
  '/surgery/acl-reconstruction/qld/',
  '/surgery/blepharoplasty/',
  '/surgery/breast-reconstruction/',
];

const kinds: PageKind[] = ['procedure', 'specialty'];

describe('Surgery hub pages', () => {
  it('build for every fixture procedure and specialty, with the title and canonical from content', async () => {
    const refs = surgeryRefs();
    expect(refs.filter((r) => r.kind === 'procedure')).toHaveLength(
      listSurgeries('procedure').length,
    );
    expect(refs.filter((r) => r.kind === 'specialty')).toHaveLength(
      listSurgeries('specialty').length,
    );
    for (const ref of refs) {
      const html = await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug });
      const title = fill(t.title, { surgery: ref.name, site: site.name });
      expect(html, ref.urlSlug).toContain(`<title>${escaped(title)}</title>`);
      expect(html, ref.urlSlug).toContain(
        `<link rel="canonical" href="${site.url}${surgeryPath(ref).slice(1)}">`,
      );
      expect(html.match(/<h1[ >]/g), ref.urlSlug).toHaveLength(1);
      expect(html, ref.urlSlug).toContain('<meta name="description" content="');
      expect(textsOf(html, 'c-breadcrumbs__item'), ref.urlSlug).toEqual([
        t.crumb_home,
        t.crumb_surgery,
        ref.name,
      ]);
    }
  }, 120_000);

  it('state the exclusion, hold the safety block once and carry the data passport once', async () => {
    for (const ref of surgeryRefs().slice(0, 12)) {
      const html = await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug });
      const main = text(html.split('<main')[1] ?? html);
      expect(main, ref.urlSlug).toContain(t.exclusion);
      expect(html.match(/class="c-safety"/g), ref.urlSlug).toHaveLength(1);
      expect(html.match(/class="c-passport"/g), ref.urlSlug).toHaveLength(1);
      expect(html, ref.urlSlug).toContain('id="surgery-safety-heading"');
    }
  }, 60_000);

  it('stamp every figure and every table, benchmarks included', async () => {
    for (const ref of surgeryRefs()) {
      const html = await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug });
      const surgery = readSurgery(ref.kind, ref.slug);
      const stamps = textsOf(html, 'c-stamp');
      expect(stamps, ref.urlSlug).toHaveLength(textsOf(html, 'c-figure').length);
      expect(
        stamps.every((s) => s.includes(surgery.period) && s.includes('2026')),
        ref.urlSlug,
      ).toBe(true);
      expect(textsOf(html, 'c-table__stamp'), ref.urlSlug).toHaveLength(
        html.match(/<table[ >]/g)?.length ?? 0,
      );
      expect(textsOf(html, 'c-tiles__tile').length, ref.urlSlug).toBe(
        Object.keys(surgery.benchmarks.national ?? {}).length,
      );
    }
  }, 120_000);

  it('show the national and state benchmarks as the dist gives them', async () => {
    const ref = refOf('procedure', 'hip-replacement');
    const surgery = readSurgery(ref.kind, ref.slug);
    const words = text(await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug }));
    expect(surgery.benchmarks.national?.median_wait).toBeDefined();
    for (const figure of Object.entries(surgery.benchmarks.national ?? {})) {
      expect(words).toContain(formatFigure(figure[0] as 'median_wait', figure[1]));
    }
    for (const { state, measures } of surgery.benchmarks.states) {
      expect(words).toContain(states[state]);
      expect(words).toContain(formatFigure('median_wait', measures.median_wait as never));
    }
  });

  it('rank only a current published figure, and no benchmark', async () => {
    let ranks = 0;
    for (const ref of surgeryRefs()) {
      const html = await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug });
      for (const cell of elementsOf(html, 'td')) {
        const withheld = cell.classes.has('is-not-published');
        expect([ref.urlSlug, cell.text, withheld && cell.inside.has('c-table__rank')]).toEqual([
          ref.urlSlug,
          cell.text,
          false,
        ]);
        ranks += cell.inside.has('c-table__rank') ? 1 : 0;
      }
      for (const row of elementsOf(html, 'tr')) {
        expect(row.classes.has('c-table__row--earlier') && row.inside.has('c-table__rank')).toBe(
          false,
        );
      }
      // The state table is the only one that holds benchmarks, and it is the first table.
      const first = html.split('<table')[1]?.split('</table>')[0] ?? '';
      expect(first.includes('c-table__rank'), ref.urlSlug).toBe(false);
      expect(html.includes('c-tiles__line'), ref.urlSlug).toBe(false);
    }
    expect(ranks).toBeGreaterThan(0);
  }, 120_000);

  it('mark a withheld cell "not published" with its reason, never 0 or blank', async () => {
    let seen = 0;
    for (const ref of surgeryRefs()) {
      const html = await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug });
      for (const cell of elementsOf(html, 'td')) {
        if (cell.classes.has('is-not-published')) {
          seen += 1;
          expect(cell.text).toMatch(/^not (?:published: \D+|reported)$/);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  }, 120_000);

  it('order every hospital table by the measured median, shortest first', async () => {
    for (const ref of surgeryRefs()) {
      const surgery = readSurgery(ref.kind, ref.slug);
      const html = await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug });
      const rows = html.split('id="hospitals-caption"')[1]?.split('</table>')[0] ?? '';
      const found = [...rows.matchAll(/<a href="\/hospital\/([a-z0-9-]+)\/">/g)].map((m) => m[1]);
      const medians = found.map((slug) => {
        const figure = surgery.hospitals.find((h) => h.slug === slug)?.measures.median_wait?.figure;
        return figure?.state === 'published' ? figure.value : null;
      });
      const published = medians.filter((m): m is number => m !== null);
      expect(published, ref.urlSlug).toEqual([...published].sort((a, b) => a - b));
      expect(
        medians.slice(0, published.length).every((m) => m !== null),
        ref.urlSlug,
      ).toBe(true);
    }
  }, 120_000);

  it('chart the national median with the states that treated the most patients', async () => {
    const ref = refOf('procedure', 'hip-replacement');
    const html = await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug });
    expect(textsOf(html, 'c-chart__caption')[0]).toContain(
      fill(t.chart_caption, { surgery: ref.name }),
    );
    expect(html).toContain('aria-label="' + fill(t.chart_name, { surgery: ref.name }));
    expect(text(html)).toContain(t.series_national);
  });

  it('say a specialty covers many operations, and name the source for a renamed procedure', async () => {
    const specialty = refOf('specialty', 'orthopaedic-surgery');
    const sHtml = await render(SurgeryHub, { kind: 'specialty', urlSlug: specialty.urlSlug });
    expect(text(sHtml)).toContain(t.specialty_note);
    const renamed = refOf('procedure', 'hip-replacement');
    const rHtml = await render(SurgeryHub, { kind: 'procedure', urlSlug: renamed.urlSlug });
    expect(text(rHtml)).toContain(fill(t.renamed_note, { source: renamed.source }));
    expect(text(rHtml)).not.toContain(t.specialty_note);
  });
});

describe('Surgery state pages', () => {
  it('build for every state with a hospital row, with the title and canonical from content', async () => {
    for (const kind of kinds) {
      const routes = stateRoutes(kind);
      expect(routes.length).toBeGreaterThan(0);
      for (const { props } of routes) {
        const ref = refOf(kind, props.slug);
        const html = await render(SurgeryState, { kind, urlSlug: props.slug, state: props.state });
        const state = states[props.state as keyof typeof states];
        const title = fill(t.state_title, { surgery: ref.name, state, site: site.name });
        expect(html, props.slug).toContain(`<title>${escaped(title)}</title>`);
        expect(html, props.slug).toContain(
          `<link rel="canonical" href="${site.url}${statePath(ref, props.state).slice(1)}">`,
        );
        const surgery = readSurgery(ref.kind, ref.slug);
        const rows = surgery.hospitals.filter((h) => h.state === props.state);
        const listed = html.match(/href="\/hospital\/[a-z0-9-]+\/"/g) ?? [];
        expect(listed, `${props.slug} ${props.state}`).toHaveLength(rows.length);
        expect(text(html.split('<main')[1] ?? html)).toContain(t.exclusion);
      }
    }
  }, 120_000);

  it('put the state figure beside the national figure, each stamped', async () => {
    const ref = refOf('procedure', 'hip-replacement');
    const html = await render(SurgeryState, {
      kind: 'procedure',
      urlSlug: ref.urlSlug,
      state: 'NSW',
    });
    const headings = textsOf(html, 'c-tiles__label');
    expect(headings).toContain(fill(t.tile_state, { measure: 'Median wait', state: states.NSW }));
    expect(headings).toContain(fill(t.tile_national, { measure: 'Median wait' }));
    expect(textsOf(html, 'c-stamp')).toHaveLength(textsOf(html, 'c-figure').length);
    expect(html).not.toContain('c-tiles__line');
  });
});

describe('Surgery index', () => {
  it('lists every surgery once, under its own heading', async () => {
    const html = await render(SurgeryIndex, {});
    const found = [...html.matchAll(/<li><a href="(\/(?:surgery|specialty)\/[a-z0-9-]+\/)">/g)].map(
      (m) => m[1],
    );
    expect(found.sort()).toEqual(surgeryRefs().map(surgeryPath).sort());
    expect(html).toContain(`<title>${escaped(fill(t.index_title, { site: site.name }))}</title>`);
    expect(html).toContain(`<link rel="canonical" href="${site.url}surgery/">`);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(text(html)).toContain(t.exclusion);
  });
});

describe('Specialty index', () => {
  it('lists every specialty from content, with breadcrumbs, the passport and the safety block', async () => {
    const html = await render(SpecialtyIndex, {});
    const found = [...html.matchAll(/<li><a href="(\/specialty\/[a-z0-9-]+\/)">/g)].map(
      (m) => m[1],
    );
    expect(found.sort()).toEqual(
      surgeryRefs()
        .filter((r) => r.kind === 'specialty')
        .map(surgeryPath)
        .sort(),
    );
    expect(html).toContain(
      `<title>${escaped(fill(t.specialty_index_title, { site: site.name }))}</title>`,
    );
    expect(html).toContain(`<link rel="canonical" href="${site.url}specialty/">`);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(text(html)).toContain(t.crumb_specialty);
    expect(text(html)).toContain(t.exclusion);
    expect(html.match(/class="c-passport"/g)).toHaveLength(1);
    expect(html).toContain('specialty-safety-heading');
  });

  it('is linked from the surgery index', async () => {
    expect(await render(SurgeryIndex, {})).toContain('href="/specialty/"');
  });
});

describe('Ranks', () => {
  it('say they are national on every ranked cell', async () => {
    let seen = 0;
    for (const ref of surgeryRefs()) {
      const html = await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug });
      for (const rank of textsOf(html, 'c-table__rank')) {
        seen += 1;
        expect(rank).toMatch(/^Rank \d[\d,]*(?:st|nd|rd|th) of [\d,]+ nationally$/);
      }
    }
    expect(seen).toBeGreaterThan(0);
  }, 120_000);
});

describe('Earlier addresses', () => {
  const built = (): Set<string> => {
    const paths = new Set<string>(['/surgery/']);
    for (const kind of kinds) {
      for (const { props } of hubRoutes(kind)) {
        paths.add(surgeryPath(refOf(kind, props.slug)));
      }
      for (const { props } of stateRoutes(kind)) {
        paths.add(statePath(refOf(kind, props.slug), props.state));
      }
    }
    return paths;
  };

  it('are all built on the fixtures that carry the surgery', () => {
    const paths = built();
    for (const address of EARLIER_ADDRESSES) {
      expect(paths.has(address), address).toBe(true);
    }
  });

  it('keep the shape /surgery/<slug>/, /surgery/<slug>/<state>/ and /surgery/<slug>/near/<place>/', () => {
    for (const path of built()) {
      if (path.startsWith('/specialty/')) {
        expect(path).toMatch(/^\/specialty\/[a-z0-9-]+\/(?:[a-z]+\/)?$/);
      } else {
        expect(path).toMatch(
          /^\/surgery\/(?:[a-z0-9-]+\/(?:(?:act|nsw|nt|qld|sa|tas|vic|wa)\/)?)?$/,
        );
      }
    }
  });

  it('give a state page to exactly the states with a hospital row, as the earlier site did', () => {
    for (const ref of surgeryRefs().filter((r) => r.kind === 'procedure')) {
      const surgery = readSurgery(ref.kind, ref.slug);
      const expected = [...new Set(surgery.hospitals.map((h) => h.state.toLowerCase()))].sort();
      const actual = stateRoutes('procedure')
        .filter((r) => r.props.slug === ref.urlSlug)
        .map((r) => r.params.state)
        .sort();
      expect(actual, ref.urlSlug).toEqual(expected);
    }
  });
});

describe('Surgery near pages', () => {
  it('build at /surgery/<slug>/near/<place>/ from the hospitals of one place', async () => {
    withNearbyPair();
    const routes = nearRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const { props } of routes) {
      const ref = refOf('procedure', props.slug);
      const area = nearArea(ref, props.area);
      const html = await render(SurgeryNear, { urlSlug: ref.urlSlug, area: area.slug });
      expect(html, props.slug).toContain(
        `<link rel="canonical" href="${site.url}${nearPath(ref, area.slug).slice(1)}">`,
      );
      expect(html, props.slug).toContain(
        `<title>${escaped(fill(t.near_title, { surgery: ref.name, place: area.prose, site: site.name }))}</title>`,
      );
      const listed = html.match(/href="\/hospital\/[a-z0-9-]+\/"/g) ?? [];
      expect(listed, props.slug).toHaveLength(area.rows.length);
      expect(text(html)).toContain(
        fill(t.near_covers_network, { network: area.network, radius: '25', anchor: area.anchor }),
      );
      expect(text(html)).toContain(t.exclusion);
      expect(html.match(/class="c-passport"/g)).toHaveLength(1);
      expect(textsOf(html, 'c-stamp')).toHaveLength(textsOf(html, 'c-figure').length);
    }
  }, 120_000);

  it('rank a hospital only on a current published figure and never repeat the state page list', async () => {
    withNearbyPair();
    for (const { props } of nearRoutes()) {
      const ref = refOf('procedure', props.slug);
      const html = await render(SurgeryNear, { urlSlug: ref.urlSlug, area: props.area });
      for (const cell of elementsOf(html, 'td')) {
        expect(cell.classes.has('is-not-published') && cell.inside.has('c-table__rank')).toBe(
          false,
        );
      }
      const surgery = readSurgery(ref.kind, ref.slug);
      const area = nearArea(ref, props.area);
      expect(area.rows.length).toBeLessThan(
        surgery.hospitals.filter((h) => h.state === area.state).length,
      );
    }
  }, 120_000);
});
