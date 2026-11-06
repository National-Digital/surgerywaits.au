import { describe, expect, it } from 'vitest';
import { planChart } from '../lib/chart';
import type { ChartSeries } from '../lib/chart';
import { formatTrendPoint } from '../lib/format';
import type { Role, TrendPoint } from '../lib/format';
import { render, text, textsOf } from '../lib/test-render';
import TrendChart from './TrendChart.astro';

function at<T>(list: readonly T[], i: number): T {
  const item = list[i];
  if (item === undefined) {
    throw new RangeError(`no item at ${String(i)}`);
  }
  return item;
}

const release = '2026-08-19';
const periods = ['2021–22', '2022–23', '2023–24', '2024–25'];
const own: TrendPoint[] = [
  [2021, 30, null],
  [2022, null, null, 'not_published:too_few_patients'],
  [2023, 0, -30],
  [2024, 45, 45],
];
const national: TrendPoint[] = [
  [2022, 40, null],
  [2023, 42, 2],
  [2024, 41, -1],
];
const series: ChartSeries[] = [
  { name: 'This hospital', release, periods, points: own },
  { name: 'Australia', release, periods: periods.slice(1), points: national },
];
const NAME = 'Median wait at This hospital, 2021–22 to 2024–25';
const props = { id: 'c', name: NAME, caption: 'Median wait by year', role: 'median_wait', series };

describe('TrendChart', () => {
  it('leaves a gap for a withheld point and never plots it at zero', () => {
    const plan = planChart('median_wait', series);
    const [mine] = plan.series;
    // The line joins the zero to the next year and leaves the first year alone.
    expect(mine?.segments).toHaveLength(1);
    expect(mine?.gaps).toHaveLength(1);
    // The published zero is a real dot on the baseline; the withheld year has no dot at all.
    expect(mine?.dots).toHaveLength(3);
    expect(mine?.dots.filter((d) => d.y === plan.bottom.toFixed(1))).toHaveLength(1);
    const nat = plan.series[1];
    expect(nat?.segments).toHaveLength(1);
    expect(nat?.gaps).toHaveLength(0);
  });

  it('breaks the line at a gap and joins the runs either side', () => {
    const years = ['2019–20', '2020–21', '2021–22', '2022–23', '2023–24', '2024–25'];
    const run: TrendPoint[] = [
      [2019, 10, null],
      [2020, 12, 2],
      [2021, null, null, 'not_published:not_published_by_aihw'],
      [2022, 14, null],
      [2023, 16, 2],
      [2024, 18, 2],
    ];
    const plan = planChart('median_wait', [{ name: 'A', release, periods: years, points: run }]);
    const [one] = plan.series;
    expect(one?.segments).toHaveLength(2);
    expect(one?.segments.map((d) => d.match(/[ML]/g)?.join(''))).toEqual(['ML', 'MLL']);
    expect(one?.dots).toHaveLength(5);
    expect(one?.gaps).toHaveLength(1);
  });

  it('starts the axis at zero with distinct ticks and a whole-number step for days and volume', () => {
    const one = (role: Role, values: number[]): string[] =>
      planChart(role, [
        {
          name: 'A',
          release,
          periods: periods.slice(0, values.length),
          points: values.map((v, i): TrendPoint => [2021 + i, v, null]),
        },
      ]).ticks.map((t) => t.text);
    const long = one('long_wait', [0.001, 0.0004, 0.001]);
    expect(long[0]).toBe('0.00%');
    expect(new Set(long).size).toBe(long.length);
    const volume = one('volume', [5, 5, 5]);
    expect(volume[0]).toBe('0');
    expect(new Set(volume).size).toBe(volume.length);
    expect(volume.every((t) => /^\d+$/.test(t))).toBe(true);
    for (const t of one('median_wait', [0, 1, 1])) {
      expect(t).toMatch(/^\d+$/);
    }
    const days = one('median_wait', [0, 1, 1]);
    expect(new Set(days).size).toBe(days.length);
    const onTime = one('on_time', [0.71, 0.74, 0.8]);
    expect(onTime).toEqual(['0%', '20%', '40%', '60%', '80%']);
  });

  it('states the period range and the release in a visible caption', async () => {
    const html = await render(TrendChart, props);
    expect(textsOf(html, 'c-chart__stamp')).toEqual([
      '2021–22 to 2024–25, released 19 August 2026',
    ]);
    expect(textsOf(html, 'c-chart__caption')[0]).toContain('Median wait by year');
  });

  it('names the picture with role img and a concise accessible name', async () => {
    const html = await render(TrendChart, props);
    expect(html).toMatch(
      /<svg[^>]*role="img"[^>]*aria-label="Median wait at This hospital, 2021–22 to 2024–25"/,
    );
    expect(html.match(/role="img"/g)).toHaveLength(1);
  });

  it('gives the table the same figures as the chart, with withheld cells in words', async () => {
    const html = await render(TrendChart, props);
    const expected = periods.flatMap((_, i) => [
      formatTrendPoint('median_wait', at(own, i)),
      i === 0 ? 'not reported' : formatTrendPoint('median_wait', at(national, i - 1)),
    ]);
    expect(textsOf(html, 'td')).toEqual(expected);
    expect(expected).toContain('not published: too few patients');
    expect(expected).toContain('0 days');
    expect(textsOf(html, 'c-table__stamp')).toEqual([
      '2021–22 to 2024–25, released 19 August 2026',
    ]);
    expect(html).toContain('<details');
  });

  it('tells the series apart without colour', async () => {
    const html = await render(TrendChart, props);
    expect(textsOf(html, 'c-chart__key-item')).toEqual([
      'This hospital',
      'Australia',
      'No figure published for this year. The table gives the reason.',
    ]);
    expect(html).toContain('stroke-dasharray="6 4"');
    const plan = planChart('median_wait', series);
    expect(new Set(plan.series.map((s) => s.shape)).size).toBe(2);
  });

  it('renders the same bytes every time', async () => {
    expect(await render(TrendChart, props)).toBe(await render(TrendChart, props));
    expect(JSON.stringify(planChart('median_wait', series))).not.toMatch(/-0\.0|NaN/);
  });

  it('ships no script and no event handler', async () => {
    const html = await render(TrendChart, props);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(text(html)).not.toBe('');
  });

  it('fails when the series disagree on release, or a point sits in the wrong period', async () => {
    const other = { ...at(series, 1), release: '2026-01-01' };
    await expect(render(TrendChart, { ...props, series: [series[0], other] })).rejects.toThrow();
    const shifted = {
      ...at(series, 0),
      periods: periods.map((_, i) => at(periods, (i + 1) % 4)),
    };
    await expect(render(TrendChart, { ...props, series: [shifted] })).rejects.toThrow();
    await expect(render(TrendChart, { ...props, series: [] })).rejects.toThrow();
  });

  it('names each scroll region from its own caption so two charts on a page differ', async () => {
    const [a, b] = await Promise.all([
      render(TrendChart, { ...props, id: 'one', caption: 'Median wait, hospital A' }),
      render(TrendChart, { ...props, id: 'two', caption: 'Median wait, hospital B' }),
    ]);
    const region = (html: string): string[] =>
      [...html.matchAll(/role="region"[^>]*aria-labelledby="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(region(a)[0]).toBe('one-caption');
    expect(region(b)[0]).toBe('two-caption');
    expect(a).not.toMatch(/role="region"[^>]*aria-label="/);
  });
});
