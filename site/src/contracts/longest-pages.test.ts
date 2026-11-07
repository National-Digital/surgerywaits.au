import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LongestBorder from '../components/LongestBorder.astro';
import LongestBySurgery from '../components/LongestBySurgery.astro';
import LongestChanges from '../components/LongestChanges.astro';
import LongestIndex from '../components/LongestIndex.astro';
import { getLongestTemplate, getSite } from '../lib/content';
import { DIST_ENV, distDirectory, readHospital, readHospitalIndex, readSurgery } from '../lib/dist';
import type { HospitalIndexRow, Surgery } from '../lib/dist';
import type { Move } from '../lib/longest-page';
import { distanceKm } from '../lib/geo';
import { isBuilt } from '../lib/links';
import {
  BORDER_COUNT,
  BORDER_PATH,
  BORDER_RADIUS_KM,
  BY_SURGERY_PATH,
  CHANGES_PATH,
  CHANGE_COUNT,
  LONGEST_COUNT,
  LONGEST_PATH,
  MOVE_VOLUME_FLOOR,
  borderPairs,
  byBiggest,
  extremes,
  falls,
  hospitalMoves,
  longestStamp,
  longestEntries,
  rankable,
  rises,
  stateMoves,
  withTies,
} from '../lib/longest-page';
import { pairRoutes, pairPath } from '../lib/pair-page';
import { fill } from '../lib/slots';
import { stateFiles, statePath } from '../lib/state-page';
import { hubRoutes, refOf, stateRoutes, surgeryPath, surgeryRefs } from '../lib/surgery-page';
import { statePath as surgeryStatePath } from '../lib/surgery-page';
import { elementsOf, render, text, textsOf, withoutJsonLd } from '../lib/test-render';

const t = getLongestTemplate();
const site = getSite();

const copies: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const copy of copies.splice(0)) {
    rmSync(copy, { recursive: true, force: true });
  }
});

// A copy of the dist that a test may edit, which the site then reads instead.
function copyDist(): string {
  const copy = mkdtempSync(join(tmpdir(), 'dist-'));
  copies.push(copy);
  cpSync(distDirectory(), copy, { recursive: true });
  vi.stubEnv(DIST_ENV, copy);
  return copy;
}

function editSurgery(copy: string, slug: string, change: (surgery: Surgery) => void): void {
  const file = join(copy, `surgeries/procedure/${slug}.json`);
  const surgery = JSON.parse(readFileSync(file, 'utf8')) as Surgery;
  change(surgery);
  writeFileSync(file, JSON.stringify(surgery));
}

// The addresses the earlier site published, from its sitemap.
const EARLIER = [
  '/longest-waits/',
  '/longest-waits/by-surgery/',
  '/longest-waits/border/',
  '/longest-waits/changes/',
];

const renderAll = async (): Promise<{ path: string; html: string }[]> => [
  { path: LONGEST_PATH, html: await render(LongestIndex, {}) },
  { path: BY_SURGERY_PATH, html: await render(LongestBySurgery, {}) },
  { path: BORDER_PATH, html: await render(LongestBorder, {}) },
  { path: CHANGES_PATH, html: await render(LongestChanges, {}) },
];

const allLongest = (): ReturnType<typeof longestEntries> => longestEntries(Number.MAX_SAFE_INTEGER);

const main = (html: string): string => text(html.split('<main')[1] ?? html);

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

// The rows of the first table after a heading id, as the text of each cell.
function rowsAfter(html: string, id: string): string[][] {
  const part = html.split(`id="${id}"`)[1] ?? '';
  const table = part.split('</table>')[0] ?? '';
  return (table.split('<tbody>')[1] ?? '')
    .split('</tr>')
    .filter((row) => row.includes('<t'))
    .map((row) =>
      textsOf(row, 'td').length + textsOf(row, 'th').length === 0
        ? []
        : [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => text(m[1] ?? '')),
    );
}

const collator = new Intl.Collator('en-AU');
const pages = await renderAll();
const page = (path: string): string => pages.find((p) => p.path === path)?.html ?? '';
const days = (value: number): string =>
  `${value.toLocaleString('en-AU')} ${value === 1 ? 'day' : 'days'}`;

describe('Longest-waits addresses', () => {
  it('keep the four addresses of the earlier site, each with a page', () => {
    expect([LONGEST_PATH, BY_SURGERY_PATH, BORDER_PATH, CHANGES_PATH]).toEqual(EARLIER);
    for (const address of EARLIER) {
      expect([address, isBuilt(address)]).toEqual([address, true]);
    }
  });
});

describe('Every longest-waits page', () => {
  it('states the exclusion, the safety block once and the passport once', () => {
    for (const { path, html } of pages) {
      expect(main(html), path).toContain(t.exclusion);
      expect((html.match(/class="c-passport"/g) ?? []).length, path).toBe(1);
      expect(html.match(/id="[a-z]+-safety-heading"/g) ?? [], path).toHaveLength(1);
    }
  });

  it('ships no script and no event handler', () => {
    for (const { path, html } of pages) {
      expect([path, /<script|\son[a-z]+=|javascript:/i.test(withoutJsonLd(html))]).toEqual([
        path,
        false,
      ]);
    }
  });

  it('carries one h1, a canonical address and breadcrumbs that end at the page', () => {
    for (const { path, html } of pages) {
      expect(html.match(/<h1[ >]/g), path).toHaveLength(1);
      expect(html, path).toContain(`<link rel="canonical" href="${site.url}${path.slice(1)}">`);
      const crumbs = textsOf(html, 'c-breadcrumbs__item');
      expect(crumbs[0], path).toBe(t.crumb_home);
      expect(crumbs.length, path).toBeGreaterThanOrEqual(2);
    }
  });

  it('gives every table a stated period and release, and names no table without one', () => {
    for (const { path, html } of pages) {
      const stamps = textsOf(html, 'c-table__stamp');
      expect(stamps.length, path).toBe(html.match(/<table[ >]/g)?.length ?? 0);
      for (const stamp of stamps) {
        expect(stamp, path).toMatch(
          /^\d{4}–\d{2}(?: to \d{4}–\d{2})?, released \d{1,2} \w+ \d{4}$/,
        );
      }
      expect(textsOf(html, 'c-stamp'), path).toHaveLength(textsOf(html, 'c-figure').length);
    }
  });

  it('links only to pages that are built', () => {
    const built = new Set<string>(['/', ...EARLIER]);
    for (const hospital of readHospitalIndex()) {
      built.add(`/hospital/${hospital.slug}/`);
    }
    for (const { params } of pairRoutes()) {
      built.add(`/hospital/${params.slug}/${params.surgery}/`);
    }
    for (const { props } of hubRoutes('procedure')) {
      built.add(surgeryPath(refOf('procedure', props.slug)));
    }
    for (const { props } of stateRoutes('procedure')) {
      built.add(surgeryStatePath(refOf('procedure', props.slug), props.state));
    }
    for (const file of stateFiles()) {
      built.add(statePath(file.state));
    }
    for (const { path, html } of pages) {
      for (const href of hrefs(html).filter((h) => h.startsWith('/'))) {
        expect([path, href, built.has(href) || isBuilt(href) || href.startsWith('/#')]).toEqual([
          path,
          href,
          true,
        ]);
      }
    }
  });

  it('states the reading note and links the other three pages', () => {
    for (const { path, html } of pages) {
      for (const paragraph of t.reading) {
        expect(main(html), path).toContain(paragraph);
      }
      const links = hrefs(html);
      for (const other of EARLIER.filter((a) => a !== path)) {
        expect([path, other, links.includes(other)]).toEqual([path, other, true]);
      }
      expect([path, links.filter((l) => l === path).length]).toEqual([path, 0]);
    }
  });
});

describe('The longest waits', () => {
  it('lists the longest current published medians, longest first, with ties sharing a rank', () => {
    const rows = rowsAfter(page(LONGEST_PATH), 'longest-caption');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThanOrEqual(Math.min(allLongest().length, LONGEST_COUNT));
    // Rebuilt from the surgery files alone.
    const expected = surgeryRefs()
      .filter((r) => r.kind === 'procedure')
      .flatMap((r) => {
        const surgery = readSurgery('procedure', r.slug);
        return surgery.hospitals.flatMap((row) => {
          const figure = row.measures.median_wait?.figure;
          const current = Object.values(row.measures).every(
            (m) => m.figure.period === surgery.period && m.figure.release === surgery.release,
          );
          return !row.closed && current && figure?.state === 'published'
            ? [{ hospital: row.name, value: figure.value }]
            : [];
        });
      })
      .sort((a, b) => b.value - a.value);
    expect(rows.map((r) => r[4])).toEqual(expected.slice(0, rows.length).map((e) => days(e.value)));
    expect(rows.map((r) => r[1])).toHaveLength(rows.length);
    const values = expected.slice(0, rows.length).map((e) => e.value);
    rows.forEach((row, i) => {
      expect(row[0]).toBe(String(1 + values.filter((v) => v > (values[i] ?? 0)).length));
    });
  });

  it('keeps a closed, earlier or not published figure out of the list', () => {
    const top = longestEntries()[0];
    expect(top).toBeDefined();
    for (const spoil of ['closed', 'earlier', 'withheld'] as const) {
      const copy = copyDist();
      editSurgery(copy, top?.ref.slug ?? '', (surgery) => {
        const row = surgery.hospitals.find((h) => h.code === top?.row.code);
        if (row === undefined) {
          throw new RangeError('the top row is missing');
        }
        if (spoil === 'closed') {
          row.closed = true;
        } else if (spoil === 'earlier') {
          for (const measure of Object.values(row.measures)) {
            measure.figure.period = '2019–20';
          }
        } else {
          const median = row.measures.median_wait;
          if (median !== undefined) {
            median.figure = {
              state: 'not_published',
              reason: 'too_few_patients',
              period: surgery.period,
              release: surgery.release,
            };
            median.rank = { status: 'unranked', why: 'not_published' };
          }
        }
      });
      expect(
        longestEntries().map((e) => `${e.row.code}/${e.ref.slug}`),
        spoil,
      ).not.toContain(`${top?.row.code ?? ''}/${top?.ref.slug ?? ''}`);
      vi.unstubAllEnvs();
    }
  });
});

describe('The range for each surgery', () => {
  it('names the shortest and longest published median of each surgery with at least two', () => {
    const all = extremes();
    expect(all.length).toBeGreaterThan(0);
    const rows = rowsAfter(page(BY_SURGERY_PATH), 'by-surgery-caption');
    expect(rows).toHaveLength(all.length);
    for (const e of all) {
      const surgery = readSurgery('procedure', e.ref.slug);
      const values = rankable(e.ref, surgery).map((x) => x.figure.value);
      expect(values.length).toBe(e.reporting);
      expect(e.reporting).toBeGreaterThanOrEqual(2);
      expect(e.shortest.figure.value).toBe(Math.min(...values));
      expect(e.longest.figure.value).toBe(Math.max(...values));
      const row = rows.find((r) => r[0] === e.ref.name);
      expect(row?.[1]).toContain(days(e.shortest.figure.value));
      expect(row?.[2]).toContain(days(e.longest.figure.value));
    }
    expect(rows.map((r) => r[0])).toEqual(
      [...rows.map((r) => r[0])].sort((a, b) => collator.compare(a ?? '', b ?? '')),
    );
  });

  it('names one hospital at each end when medians tie, and counts the others', async () => {
    const wide = extremes().find((e) => e.reporting >= 3);
    expect(wide).toBeDefined();
    const slug = wide?.ref.slug ?? '';
    const copy = copyDist();
    editSurgery(copy, slug, (surgery) => {
      for (const entry of rankable(wide?.ref as never, surgery)) {
        const row = surgery.hospitals.find((h) => h.code === entry.row.code);
        const figure = row?.measures.median_wait?.figure;
        if (figure?.state === 'published') {
          figure.value = 7;
        }
      }
    });
    const tied = extremes().find((e) => e.ref.slug === slug);
    const names = rankable(tied?.ref as never, readSurgery('procedure', slug))
      .map((e) => e.row.name)
      .sort((a, b) => collator.compare(a, b));
    expect(tied?.shortest.row.name).toBe(names[0]);
    expect(tied?.longest.row.name).toBe(names.at(-1));
    expect(tied?.shortestTied).toBe(names.length - 1);
    expect(tied?.longestTied).toBe(names.length - 1);
    const row = rowsAfter(await render(LongestBySurgery, {}), 'by-surgery-caption').find(
      (r) => r[0] === tied?.ref.name,
    );
    const note = fill(t.tied_many, { count: String(names.length - 1) });
    expect(row?.[1]).toContain(note);
    expect(row?.[2]).toContain(note);
  });

  it('counts one other hospital with the singular wording', async () => {
    const wide = extremes().find((e) => e.reporting >= 3);
    const slug = wide?.ref.slug ?? '';
    const copy = copyDist();
    const high = new Set<string>();
    editSurgery(copy, slug, (surgery) => {
      const entries = rankable(wide?.ref as never, surgery).sort((a, b) =>
        collator.compare(a.row.name, b.row.name),
      );
      for (const entry of entries.slice(0, 2)) {
        const figure = surgery.hospitals.find((h) => h.code === entry.row.code)?.measures
          .median_wait?.figure;
        if (figure?.state === 'published') {
          figure.value = 99999;
          high.add(entry.row.name);
        }
      }
    });
    const tied = extremes().find((e) => e.ref.slug === slug);
    expect(tied?.longestTied).toBe(1);
    expect(tied?.longest.row.name).toBe([...high].sort((a, b) => collator.compare(a, b)).at(-1));
    const row = rowsAfter(await render(LongestBySurgery, {}), 'by-surgery-caption').find(
      (r) => r[0] === tied?.ref.name,
    );
    expect(row?.[2]).toContain(fill(t.tied_one, { count: '1' }));
  });
});

function located(row: HospitalIndexRow | undefined): {
  state: string;
  latitude: number;
  longitude: number;
} {
  if (row === undefined || row.latitude === null || row.longitude === null) {
    throw new RangeError('a pair needs both locations');
  }
  return { state: row.state, latitude: row.latitude, longitude: row.longitude };
}

describe('The border page', () => {
  // A copy in which a Queensland and a New South Wales hospital sit 60 kilometres apart.
  function nearBorder(km?: number): void {
    const copy = copyDist();
    const file = join(copy, 'hospitals.json');
    const index = JSON.parse(readFileSync(file, 'utf8')) as { hospitals: HospitalIndexRow[] };
    const nsw = index.hospitals.find((h) => h.slug === 'wollongong-hospital');
    const qld = index.hospitals.find((h) => h.slug === 'mater-adult-hospital');
    if (nsw === undefined || qld === undefined || nsw.latitude === null) {
      throw new RangeError('the fixture lacks the hospitals this test moves');
    }
    // One degree of latitude spans the same distance everywhere on the sphere.
    const perDegree = distanceKm({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    qld.latitude = nsw.latitude + (km === undefined ? 0.5 : km / perDegree);
    qld.longitude = nsw.longitude;
    writeFileSync(file, JSON.stringify(index));
  }

  it('pairs a hospital with its best published alternative across a border within the radius', () => {
    nearBorder();
    const pairs = borderPairs();
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeGreaterThanOrEqual(Math.min(borderPairs(1000).length, BORDER_COUNT));
    const index = new Map(readHospitalIndex().map((h) => [h.slug, h]));
    for (const p of pairs) {
      const from = located(index.get(p.from.row.slug));
      const to = located(index.get(p.to.row.slug));
      expect(from.state).not.toBe(to.state);
      expect(distanceKm(from, to)).toBeLessThanOrEqual(BORDER_RADIUS_KM);
      expect(p.difference).toBe(p.from.figure.value - p.to.figure.value);
      expect(p.difference).toBeGreaterThan(0);
      // No other hospital across a border and inside the radius gives a larger difference.
      const surgery = readSurgery('procedure', p.ref.slug);
      for (const other of rankable(p.ref, surgery)) {
        const place = index.get(other.row.slug);
        if (
          place?.latitude !== null &&
          place?.latitude !== undefined &&
          place.state !== from.state
        ) {
          const gap = p.from.figure.value - other.figure.value;
          if (distanceKm(from, located(place)) <= BORDER_RADIUS_KM) {
            expect(gap).toBeLessThanOrEqual(p.difference);
          }
        }
      }
    }
    expect(pairs.map((p) => p.difference)).toEqual(
      [...pairs.map((p) => p.difference)].sort((a, b) => b - a),
    );
  });

  it('pairs two hospitals just inside the radius and leaves out two just beyond it', () => {
    const joins = (): boolean =>
      borderPairs(1000).some((p) =>
        [p.from.row.slug, p.to.row.slug].every((slug) =>
          ['wollongong-hospital', 'mater-adult-hospital'].includes(slug),
        ),
      );
    nearBorder(BORDER_RADIUS_KM - 0.1);
    expect(joins()).toBe(true);
    nearBorder(BORDER_RADIUS_KM + 0.1);
    expect(joins()).toBe(false);
  });

  it('shows each pair with both medians, the distance and the difference', async () => {
    nearBorder();
    const html = await render(LongestBorder, {});
    const rows = rowsAfter(html, 'border-caption');
    const pairs = borderPairs();
    expect(rows).toHaveLength(pairs.length);
    pairs.forEach((p, i) => {
      expect(rows[i]?.[1]).toBe(p.ref.name);
      expect(rows[i]?.[2]).toContain(days(p.from.figure.value));
      expect(rows[i]?.[3]).toContain(days(p.to.figure.value));
      expect(rows[i]?.[5]).toBe(days(p.difference));
    });
    expect(html).toContain(
      fill(t.border_place, { state: 'NSW', median: days(pairs[0]?.from.figure.value ?? 0) }).split(
        ' · ',
      )[0] ?? '',
    );
  });

  it('says so when no pair qualifies', async () => {
    const copy = copyDist();
    const file = join(copy, 'hospitals.json');
    const index = JSON.parse(readFileSync(file, 'utf8')) as { hospitals: HospitalIndexRow[] };
    for (const h of index.hospitals) {
      h.latitude = null;
      h.longitude = null;
    }
    writeFileSync(file, JSON.stringify(index));
    expect(borderPairs()).toEqual([]);
    const html = await render(LongestBorder, {});
    expect(html).not.toContain('<table');
    expect(main(html)).toContain(
      fill(t.border_none, { radius: '100 kilometres', period: longestStamp().period }),
    );
  });
});

describe('The changes page', () => {
  it('lists state changes between two published medians, biggest first', () => {
    const moves = stateMoves();
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) {
      expect(m.from.state).toBe('published');
      expect(m.to.state).toBe('published');
      expect(m.change).toBe(m.to.value - m.from.value);
      expect(m.to.period > m.from.period).toBe(true);
      // The figures agree with the surgery file's own series.
      const surgery = readSurgery('procedure', m.ref.slug);
      const series = surgery.benchmarks.trends.find(
        (s) => s.scope === m.state && s.role === 'median_wait',
      );
      expect(series?.points.some((p) => p[1] === m.to.value)).toBe(true);
      expect(series?.points.some((p) => p[1] === m.from.value)).toBe(true);
    }
    const sizes = moves.map((m) => Math.abs(m.change));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    const html = page(CHANGES_PATH);
    const rises = rowsAfter(html, 'state-rises-caption');
    expect(rises.length).toBeGreaterThanOrEqual(1);
    for (const row of rises) {
      expect(row[4]).toMatch(/^up [\d,]+ days?$/);
    }
    for (const row of rowsAfter(html, 'state-falls-caption')) {
      expect(row[4]).toMatch(/^down [\d,]+ days?$/);
    }
  });

  it('lists only hospital changes that stand on at least the volume floor, open and current', () => {
    for (const m of hospitalMoves()) {
      const hospital = readHospital(m.hospital?.slug ?? '');
      const surgery = hospital.surgeries.find((s) => s.slug === m.ref.slug);
      const volume = surgery?.measures.volume?.figure;
      expect(hospital.closed).toBe(false);
      expect(surgery?.stale).toBe(false);
      expect(volume?.state === 'published' && volume.value >= MOVE_VOLUME_FLOOR).toBe(true);
      expect(surgery?.measures.median_wait?.figure).toMatchObject({ value: m.to.value });
      expect(m.change).toBe(m.to.value - m.from.value);
      expect(m.href).toBe(pairPath(m.hospital?.slug ?? '', m.ref));
    }
  });

  it('includes a pair at exactly the volume floor and leaves out one below it', () => {
    const target = hospitalMoves()[0];
    expect(target).toBeDefined();
    const slug = target?.hospital?.slug ?? '';
    const withVolume = (value: number): boolean => {
      const copy = copyDist();
      const file = join(copy, `hospitals/${slug}.json`);
      const hospital = JSON.parse(readFileSync(file, 'utf8')) as ReturnType<typeof readHospital>;
      const figure = hospital.surgeries.find((x) => x.slug === target?.ref.slug)?.measures.volume
        ?.figure;
      if (figure?.state !== 'published') {
        throw new RangeError('the volume is missing');
      }
      figure.value = value;
      writeFileSync(file, JSON.stringify(hospital));
      return hospitalMoves().some(
        (m) => m.hospital?.slug === slug && m.ref.slug === target?.ref.slug,
      );
    };
    expect(withVolume(MOVE_VOLUME_FLOOR)).toBe(true);
    expect(withVolume(MOVE_VOLUME_FLOOR - 1)).toBe(false);
  });

  it('keeps every row that ties the last one shown, in a fixed order whatever the input order', () => {
    const figure = { state: 'published' as const, value: 1, period: '2023–24', release: 'r' };
    const move = (hospital: string, state: string, slug: string, change = 10): Move => ({
      ref: { slug, name: slug, kind: 'procedure' } as Move['ref'],
      state,
      hospital: { slug: hospital, name: hospital },
      from: figure,
      to: { ...figure, value: 1 + change },
      change,
      href: '/',
    });
    const tied = [
      move('Delta', 'wa', 'x'),
      move('Alpha', 'vic', 'x'),
      move('Bravo', 'vic', 'y'),
      move('Bravo', 'vic', 'x'),
      move('Charlie', 'nsw', 'x'),
      move('Echo', 'nsw', 'x', 4),
    ];
    const expected = ['Charlie/x', 'Alpha/x', 'Bravo/x', 'Bravo/y', 'Delta/x'];
    for (const order of [tied, [...tied].reverse(), [...tied.slice(2), ...tied.slice(0, 2)]]) {
      const cut = rises([...order].sort(byBiggest), 3).map(
        (m) => `${m.hospital?.name ?? ''}/${m.ref.slug}`,
      );
      expect(cut).toEqual(expected);
    }
    const falling = tied.map((m) => ({ ...m, change: -m.change }));
    expect(falls([...falling].sort(byBiggest), 3)).toHaveLength(5);
    expect(falls([...falling].sort(byBiggest), 5)).toHaveLength(5);
    expect(rises([...tied].sort(byBiggest), 6)).toHaveLength(6);
  });

  it('cuts the other lists on the same rule', () => {
    const items = [9, 8, 7, 7, 7, 5, 4];
    expect(withTies(items, 2, (n) => n)).toEqual([9, 8]);
    expect(withTies(items, 3, (n) => n)).toEqual([9, 8, 7, 7, 7]);
    expect(withTies(items, 4, (n) => n)).toEqual([9, 8, 7, 7, 7]);
    expect(withTies(items, 20, (n) => n)).toEqual(items);
  });

  it.skipIf(process.env['SURGERYWAITS_DIST'] === undefined)(
    'ends each list on a value that no omitted row shares',
    () => {
      const stamp = longestStamp();
      expect(stamp.period).not.toBe('');
      const states = stateMoves();
      const hospitals = hospitalMoves();
      const cuts: { shown: Move[]; all: Move[] }[] = [
        { shown: rises(states), all: states.filter((m) => m.change > 0) },
        { shown: falls(states), all: states.filter((m) => m.change < 0) },
        { shown: rises(hospitals), all: hospitals.filter((m) => m.change > 0) },
        { shown: falls(hospitals), all: hospitals.filter((m) => m.change < 0) },
      ];
      for (const { shown, all } of cuts) {
        expect(shown).toEqual(all.slice(0, shown.length));
        const last = shown.at(-1);
        const next = all[shown.length];
        if (last !== undefined && next !== undefined) {
          expect(Math.abs(next.change)).toBeLessThan(Math.abs(last.change));
        }
        expect(shown.length).toBeGreaterThanOrEqual(Math.min(all.length, CHANGE_COUNT));
      }
      const longest = allLongest();
      const shownLongest = longestEntries();
      const nextLongest = longest[shownLongest.length];
      if (nextLongest !== undefined) {
        expect(nextLongest.figure.value).toBeLessThan(shownLongest.at(-1)?.figure.value ?? 0);
      }
      const pairs = borderPairs();
      const more = borderPairs(1000)[pairs.length];
      if (more !== undefined) {
        expect(more.difference).toBeLessThan(pairs.at(-1)?.difference ?? 0);
      }
      expect(shownLongest.length).toBeGreaterThanOrEqual(Math.min(longest.length, LONGEST_COUNT));
    },
  );

  it('states both periods in every row and one span in every caption', () => {
    const html = page(CHANGES_PATH);
    for (const cell of textsOf(html, 'td').filter((c) => /\(\d{4}–\d{2}\)/.test(c))) {
      expect(cell).toMatch(/^[\d,]+ days? \(\d{4}–\d{2}\)$/);
    }
    for (const stamp of textsOf(html, 'c-table__stamp')) {
      expect(stamp).toMatch(/^\d{4}–\d{2} to \d{4}–\d{2}, released \d{1,2} \w+ \d{4}$/);
    }
    expect(elementsOf(html, 'c-table__rank')).toEqual([]);
  });
});
