import { describe, expect, it } from 'vitest';
import type { Figure } from '../lib/format';
import { sortRows } from '../lib/table';
import type { TableRow } from '../lib/table';
import { render, text, textsOf } from '../lib/test-render';
import DataTable from './DataTable.astro';

const stamp = { period: '2024–25', release: '2026-08-19' };
const published = (value: number, period = stamp.period): Figure => ({
  state: 'published',
  value,
  ...stamp,
  period,
});
const withheld: Figure = { state: 'not_published', reason: 'too_few_patients', ...stamp };
const missing: Figure = { state: 'not_reported', reason: 'not_reported_by_source', ...stamp };
const STAMP = '2024–25, released 19 August 2026';

const columns = [
  { heading: 'Median wait', role: 'median_wait' as const },
  { heading: 'Patients treated', role: 'volume' as const },
];
const rows: TableRow[] = [
  {
    code: 'a',
    name: 'Alpha Hospital',
    cells: [{ figure: published(55), rank: { position: 3, of: 40 } }, { figure: published(1204) }],
  },
  { code: 'b', name: 'Beta Hospital', cells: [{ figure: withheld }, { figure: published(0) }] },
  {
    code: 'g',
    name: 'Gamma Hospital',
    stale: true,
    cells: [{ figure: published(70, '2017–18') }, { figure: missing }],
  },
];
const props = { id: 't', caption: 'Waits', rowHeading: 'Hospital', columns, rows };

describe('DataTable', () => {
  it('has a caption that carries the period and release once', async () => {
    const html = await render(DataTable, props);
    expect(textsOf(html, 'c-table__caption')).toEqual([`Waits ${STAMP}`]);
    expect(textsOf(html, 'c-table__stamp')).toEqual([STAMP]);
    expect(html).toContain('<thead');
    expect(html.match(/<table/g)).toHaveLength(1);
  });

  it('gives every header a scope', async () => {
    const html = await render(DataTable, props);
    expect(html.match(/<th[^>]*scope="col"/g)).toHaveLength(3);
    expect(html.match(/<th[^>]*scope="row"/g)).toHaveLength(3);
    expect(html.match(/<th(?=[\s>])(?![^>]*scope=)/g)).toBeNull();
  });

  it('shows a withheld cell in words and a published zero as zero', async () => {
    const html = await render(DataTable, props);
    const values = textsOf(html, 'td');
    expect(values).toEqual([
      '55 days Rank 3rd of 40 nationally',
      '1,204 surgeries',
      'not published: too few patients',
      '0 surgeries',
      '70 days 2017–18, released 19 August 2026',
      'not reported 2024–25, released 19 August 2026',
    ]);
    expect(html).toContain('is-not-published');
  });

  it('ranks only a current published cell', async () => {
    const html = await render(DataTable, props);
    expect(textsOf(html, 'c-table__rank')).toEqual(['Rank 3rd of 40 nationally']);
    for (const bad of [
      { figure: withheld, rank: { position: 1, of: 2 } },
      { figure: published(5), rank: { position: 1, of: 2 } },
    ]) {
      const stale = bad.figure.state === 'published';
      const broken: TableRow[] = [
        { code: 'good', name: 'Good', cells: [{ figure: published(2) }, { figure: published(3) }] },
        { code: 'bad', name: 'Bad', stale, cells: [bad, { figure: published(1) }] },
      ];
      await expect(render(DataTable, { ...props, rows: broken })).rejects.toThrow();
    }
  });

  it('marks a stale row and gives its figures their own period', async () => {
    const html = await render(DataTable, props);
    expect(textsOf(html, 'c-table__marker')).toEqual(['Earlier period']);
    expect(html).toContain('c-table__row--earlier');
    expect(textsOf(html, 'c-table__period')).toEqual(['2017–18, released 19 August 2026', STAMP]);
  });

  it('puts the table in a labelled, focusable scroll region', async () => {
    const html = await render(DataTable, props);
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-labelledby="t-caption"');
    expect(text(html)).toContain('This table scrolls sideways on a narrow screen.');
  });

  it('fails when the current rows disagree on their period or a row is short', async () => {
    const other: TableRow = {
      code: 'o',
      name: 'Other',
      cells: [{ figure: published(1, '2023–24') }, { figure: published(2) }],
    };
    await expect(render(DataTable, { ...props, rows: [...rows, other] })).rejects.toThrow();
    const short: TableRow = { code: 's', name: 'Short', cells: [{ figure: published(1) }] };
    await expect(render(DataTable, { ...props, rows: [...rows, short] })).rejects.toThrow();
  });
});

describe('sortRows', () => {
  it('orders current measured values and keeps the rest in the order given', () => {
    const sorted = sortRows(rows, 0, 'median_wait').map((r) => r.name);
    expect(sorted).toEqual(['Alpha Hospital', 'Beta Hospital', 'Gamma Hospital']);
    const volume = sortRows(rows, 1, 'volume').map((r) => r.name);
    expect(volume).toEqual(['Alpha Hospital', 'Beta Hospital', 'Gamma Hospital']);
    const more: TableRow = {
      code: 'd',
      name: 'Delta',
      cells: [{ figure: published(9) }, { figure: published(5) }],
    };
    expect(sortRows([...rows, more], 0, 'median_wait').map((r) => r.name)).toEqual([
      'Delta',
      'Alpha Hospital',
      'Beta Hospital',
      'Gamma Hospital',
    ]);
    expect(sortRows([...rows, more], 0, 'on_time')[0]?.name).toBe('Alpha Hospital');
  });
});

describe('sortRows determinism', () => {
  it('breaks ties and orders unmeasured rows by code, whatever the names or input order', () => {
    const row = (code: string, figure: Figure, stale = false): TableRow => ({
      code,
      name: 'Same Hospital',
      stale,
      cells: [{ figure }],
    });
    const input = [
      row('c', published(5)),
      row('z', withheld),
      row('a', published(5)),
      row('m', published(9, '2017–18'), true),
      row('b', published(5)),
      row('k', missing),
    ];
    const order = (rs: TableRow[]): string[] => sortRows(rs, 0, 'median_wait').map((r) => r.code);
    expect(order(input)).toEqual(['a', 'b', 'c', 'k', 'm', 'z']);
    expect(order([...input].reverse())).toEqual(['a', 'b', 'c', 'k', 'm', 'z']);
  });

  it('builds a stated range from structured parts and rejects a malformed one', async () => {
    const span = { first: '2023–24', last: '2024–25', release: '2026-08-19' };
    const html = await render(DataTable, { ...props, span });
    expect(textsOf(html, 'c-table__stamp')).toEqual([
      '2023–24 to 2024–25, released 19 August 2026',
    ]);
    for (const bad of [
      { ...span, first: '' },
      { ...span, release: '' },
      { ...span, first: '2025–26' },
      { ...span, release: '2025-01-01' },
      { ...span, last: '2023–24', first: '2023–24' },
    ]) {
      await expect(render(DataTable, { ...props, span: bad })).rejects.toThrow();
    }
  });
});
