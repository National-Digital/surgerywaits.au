import { describe, expect, it } from 'vitest';

import RankingTable from '../components/RankingTable.astro';
import type { Figure } from './format';
import { assertRanking, competitionRanks } from './ranking-table';
import type { RankingModel } from './ranking-table';
import { render, textsOf } from './test-render';

const published = (value: number, period = '2024–25', release = '2026-08-19'): Figure => ({
  state: 'published',
  value,
  period,
  release,
});
const withheld: Figure = {
  state: 'not_published',
  reason: 'too_few_patients',
  period: '2024–25',
  release: '2026-08-19',
};

const model = (figures: Figure[]): RankingModel => ({
  columns: ['Name', 'Wait'],
  rows: figures.map((figure, i) => ({
    key: String(i),
    basis: [figure],
    cells: [
      { text: `Row ${String(i)}`, heading: true },
      { text: 'x', figure },
    ],
  })),
});

describe('competitionRanks', () => {
  it('gives equal values one rank and skips the places they took', () => {
    expect(competitionRanks([9, 7, 7, 4])).toEqual([1, 2, 2, 4]);
    expect(competitionRanks([])).toEqual([]);
  });
});

describe('assertRanking', () => {
  it('returns the one stamp that every figure shares', () => {
    expect(assertRanking(model([published(5), published(7)]))).toBe(
      '2024–25, released 19 August 2026',
    );
  });

  it('refuses an order that stands on a figure that is not published', () => {
    expect(() => assertRanking(model([published(5), withheld]))).toThrow(RangeError);
  });

  it('refuses two stamps in one table that names no span', () => {
    expect(() => assertRanking(model([published(5), published(7, '2023–24')]))).toThrow(RangeError);
  });

  it('refuses a figure outside the span the table names', () => {
    const rows = model([published(5, '2022–23')]);
    const span = { first: '2023–24', last: '2024–25', release: '2026-08-19' };
    expect(() => assertRanking({ ...rows, span })).toThrow(RangeError);
    expect(assertRanking({ ...model([published(5, '2023–24')]), span })).toBe(
      '2023–24 to 2024–25, released 19 August 2026',
    );
  });

  it('refuses a row with the wrong number of cells', () => {
    const rows = model([published(5)]);
    expect(() => assertRanking({ ...rows, columns: ['Name'] })).toThrow(RangeError);
  });
});

describe('RankingTable', () => {
  it('states its stamp once and puts the row name in a row header', async () => {
    const html = await render(RankingTable, {
      id: 'sample',
      caption: 'Sample',
      ...model([published(5)]),
    });
    expect(textsOf(html, 'c-table__stamp')).toEqual(['2024–25, released 19 August 2026']);
    expect(textsOf(html, 'th')).toContain('Row 0');
  });

  it('fails the build on a withheld figure behind an order', async () => {
    await expect(
      render(RankingTable, { id: 'sample', caption: 'Sample', ...model([withheld]) }),
    ).rejects.toThrow();
  });
});
