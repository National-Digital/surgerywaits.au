import { describe, expect, it } from 'vitest';

import type { Hospital, HospitalSurgery, Measure, Trend } from './dist';
import { listDist, readHospital } from './dist';
import {
  hospitalPath,
  hospitalSlugs,
  rankOf,
  surgeryTable,
  trendCharts,
  urgencyTiles,
} from './hospital-page';
import type { Figure } from './format';
import { fill, slotsOf } from './slots';

const stamp = { period: '2024–25', release: '2026-08-19' };
const published = (value: number, period = stamp.period): Figure => ({
  state: 'published',
  value,
  ...stamp,
  period,
});
const withheld: Figure = { state: 'not_published', reason: 'too_few_patients', ...stamp };
const measure = (figure: Figure, ranked = true): Measure => ({
  figure,
  rank: ranked
    ? { status: 'ranked', position: 2, of: 5 }
    : { status: 'unranked', why: 'not_a_ranked_measure' },
});

describe('hospitalPath', () => {
  it('keeps the address the earlier site used', () => {
    expect(hospitalPath('albany-hospital')).toBe('/hospital/albany-hospital/');
  });
});

describe('hospitalSlugs', () => {
  it('lists the hospitals the index and the files share', () => {
    expect(hospitalSlugs()).toEqual(listDist('hospitals'));
    expect(hospitalSlugs().length).toBeGreaterThan(10);
  });
});

describe('rankOf', () => {
  it('keeps a rank on a current published figure', () => {
    expect(rankOf(measure(published(9)), false)).toEqual({ position: 2, of: 5 });
  });

  it('drops a rank from a stale, withheld or unranked figure', () => {
    expect(rankOf(measure(published(9)), true)).toBeUndefined();
    expect(rankOf(measure(withheld), false)).toBeUndefined();
    expect(rankOf(measure(published(9), false), false)).toBeUndefined();
  });
});

function surgery(slug: string, stale: boolean, period = stamp.period): HospitalSurgery {
  const figure = (value: number): Figure => published(value, period);
  return {
    kind: 'procedure',
    slug,
    name: slug,
    stale,
    measures: {
      median_wait: measure(figure(10)),
      long_wait: measure(figure(0.1)),
      volume: measure(figure(30), false),
    },
  };
}

const hospital = (surgeries: HospitalSurgery[]): Hospital => ({
  ...readHospital(listDist('hospitals')[0] ?? ''),
  surgeries,
});

describe('surgeryTable', () => {
  it('has no table when the hospital reports no surgery of the kind', () => {
    expect(surgeryTable(hospital([surgery('a', false)]), 'specialty')).toBeNull();
  });

  it('states no range while a current row gives the table its period', () => {
    const table = surgeryTable(
      hospital([surgery('a', false), surgery('b', true, '2018–19')]),
      'procedure',
    );
    expect(table?.span).toBeUndefined();
    expect(table?.rows.map((r) => r.code)).toEqual(['a', 'b']);
    expect(table?.rows[1]?.cells.some((c) => c.rank !== undefined)).toBe(false);
  });

  it('states the range of earlier periods when every row is stale', () => {
    const table = surgeryTable(
      hospital([surgery('a', true, '2017–18'), surgery('b', true, '2018–19')]),
      'procedure',
    );
    expect(table?.span).toEqual({ first: '2017–18', last: '2018–19', release: stamp.release });
  });

  it('fails when a surgery lacks a measure the table shows', () => {
    const broken = surgery('a', false);
    delete broken.measures.long_wait;
    expect(() => surgeryTable(hospital([broken]), 'procedure')).toThrow(/long_wait/);
  });
});

describe('urgencyTiles', () => {
  const names = { urgent: 'One', routine: 'Two' };
  const urgency = (slug: string): HospitalSurgery => ({
    ...surgery(slug, false),
    kind: 'urgency',
    measures: { median_wait: measure(published(7)), on_time: measure(published(0.9)) },
  });
  const data = (surgeries: HospitalSurgery[]): Parameters<typeof urgencyTiles>[0] => ({
    hospital: hospital(surgeries),
    trend: { series: [], sources: [] },
    queensland: null,
  });

  it('orders tiles by measure and then by the order of the content', () => {
    const tiles = urgencyTiles(data([urgency('routine'), urgency('urgent')]), names, [
      'urgent',
      'routine',
    ]);
    expect(tiles.map((t) => t.key)).toEqual([
      'median_wait-urgent',
      'median_wait-routine',
      'on_time-urgent',
      'on_time-routine',
    ]);
  });

  it('fails on a category the content does not name', () => {
    expect(() => urgencyTiles(data([urgency('other')]), names, ['urgent'])).toThrow(/other/);
  });

  it('gives a stale tile no rank and no change', () => {
    const stale = { ...urgency('urgent'), stale: true };
    const [tile] = urgencyTiles(data([stale]), names, ['urgent']);
    expect(tile?.rank).toBeUndefined();
    expect(tile?.change).toBeNull();
  });
});

describe('trendCharts', () => {
  const series = (slug: string, periods: string[]): Trend['series'][number] => ({
    kind: 'urgency',
    slug,
    role: 'median_wait',
    release: stamp.release,
    periods,
    points: periods.map((_, i) => [2000 + i, 10, null] as const),
  });

  it('puts series with the same periods on one chart and gives any other its own', () => {
    const trend: Trend = {
      series: [
        series('a', ['2023–24', '2024–25']),
        series('b', ['2023–24', '2024–25']),
        series('c', ['2022–23', '2023–24']),
      ],
      sources: [],
    };
    const charts = trendCharts(trend, { a: 'A', b: 'B', c: 'C' }, ['a', 'b', 'c']);
    expect(charts.map((c) => c.series.map((s) => s.name))).toEqual([['A', 'B'], ['C']]);
    expect(new Set(charts.map((c) => c.id)).size).toBe(2);
  });
});

describe('fill', () => {
  it('fills each slot', () => {
    expect(fill('{a} and {b} and {a}', { a: '1', b: '2' })).toBe('1 and 2 and 1');
    expect(slotsOf('{b} {a} {b}')).toEqual(['a', 'b']);
  });

  it('fails on a missing or an unknown slot', () => {
    expect(() => fill('{a} {b}', { a: '1' })).toThrow(RangeError);
    expect(() => fill('{a}', { a: '1', b: '2' })).toThrow(RangeError);
  });
});
