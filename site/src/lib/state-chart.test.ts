import { describe, expect, it } from 'vitest';

import type { Credit } from './credits';
import type { Figure } from './format';
import { stateChartFiles, stateChartSvg } from './state-chart';

const credit = {
  publisher: { name: 'Australian Institute of Health and Welfare' },
  licence: 'CC-BY-4.0',
} as Credit;
const published = (value: number): Figure => ({
  state: 'published',
  value,
  period: '2024–25',
  release: '2026-08-19',
});
const chart = (bars: { name: string; figure: Figure }[]): string =>
  stateChartSvg({
    title: 'Hip replacement & more',
    period: '2024–25',
    release: '2026-08-19',
    bars,
    credits: [credit, credit],
  });

describe('the state chart', () => {
  it('orders published bars shortest first and names the licence once', () => {
    const svg = chart([
      { name: 'Victoria', figure: published(68) },
      { name: 'Queensland', figure: published(30) },
    ]);
    expect(svg.indexOf('Queensland')).toBeLessThan(svg.indexOf('>Victoria<'));
    expect(svg).toContain('Hip replacement &amp; more');
    expect(svg).toContain('2024–25, released 19 August 2026');
    expect(svg.match(/CC BY 4\.0/gu)).toHaveLength(1);
    expect(svg).toContain('role="img"');
  });

  it('gives a withheld state its reason, no bar and no zero', () => {
    const svg = chart([
      {
        name: 'Tasmania',
        figure: { state: 'not_published', reason: 'too_few_patients' } as Figure,
      },
      { name: 'Victoria', figure: published(68) },
    ]);
    expect(svg).toContain('Not published: too few patients');
    expect(svg).not.toContain('0 days');
    expect(svg.match(/fill="#1844b9"/gu)).toHaveLength(1);
    expect(svg.indexOf('>Victoria<')).toBeLessThan(svg.indexOf('>Tasmania<'));
  });

  it('refuses a figure from another period', () => {
    expect(() =>
      chart([
        {
          name: 'Victoria',
          figure: { state: 'published', value: 1, period: '2023–24', release: '2025-08-01' },
        },
      ]),
    ).toThrow(RangeError);
  });

  it('writes the same file for the same data and one file for each address', () => {
    const files = stateChartFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files.map((f) => f.slug)).size).toBe(files.length);
    expect(stateChartFiles()).toEqual(files);
    for (const { svg } of files) {
      expect(svg).not.toMatch(/NaN|undefined/u);
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg.endsWith('</svg>\n')).toBe(true);
    }
  });
});
