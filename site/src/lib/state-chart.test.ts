import { describe, expect, it } from 'vitest';

import type { Credit } from './credits';
import type { Figure, NotPublishedFigure } from './format';
import { formatNotPublished } from './format';
import { stateBars, stateChartFiles, stateChartSvg } from './state-chart';

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

// A conservative width per character: sans-serif text at these sizes averages under 0.6 em.
const EM = 0.6;
const REASONS = {
  too_few_patients: 1,
  no_patients_reported: 1,
  not_published_by_aihw: 1,
  no_peer_group_comparison: 1,
  not_given_by_queensland_health: 1,
};
const unescape = (text: string): string =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');

function texts(svg: string): { content: string; start: number; end: number }[] {
  return [
    ...svg.matchAll(
      /<text x="(\d+)"[^>]*?(text-anchor="end" )?font-size="(\d+)"[^>]*>([^<]*)<\/text>/gu,
    ),
  ].map(([, x, anchor, size, raw]) => {
    const content = unescape(raw ?? '');
    const width = content.length * Number(size) * EM;
    const at = Number(x);
    return anchor !== undefined
      ? { content, start: at - width, end: at }
      : { content, start: at, end: at + width };
  });
}

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
        figure: {
          state: 'not_published',
          reason: 'too_few_patients',
          period: '2024–25',
          release: '2026-08-19',
        },
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

  it('refuses a withheld figure from another period', () => {
    expect(() =>
      chart([
        {
          name: 'Victoria',
          figure: {
            state: 'not_reported',
            reason: 'not_reported_by_source',
            period: '2023–24',
            release: '2026-08-19',
          },
        },
      ]),
    ).toThrow(RangeError);
  });

  it('keeps every text inside the canvas for every reason code', () => {
    const reasons = Object.keys(REASONS) as NotPublishedFigure['reason'][];
    const bars: { name: string; figure: Figure }[] = [
      ...reasons.map((reason) => ({
        name: 'Australian Capital Territory',
        figure: {
          state: 'not_published' as const,
          reason,
          period: '2024–25',
          release: '2026-08-19',
        },
      })),
      {
        name: 'Northern Territory',
        figure: {
          state: 'not_reported' as const,
          reason: 'not_reported_by_source' as const,
          period: '2024–25',
          release: '2026-08-19',
        },
      },
      { name: 'Victoria', figure: published(68) },
    ];
    const svgs = [chart(bars), ...stateChartFiles().map((f) => f.svg)];
    for (const svg of svgs) {
      for (const text of texts(svg)) {
        expect(text.start, text.content).toBeGreaterThanOrEqual(0);
        expect(text.end, text.content).toBeLessThanOrEqual(720);
      }
    }
  });

  it('names the reason in the chart for every reason code', () => {
    for (const reason of Object.keys(REASONS)) {
      const svg = chart([
        {
          name: 'Tasmania',
          figure: {
            state: 'not_published',
            reason,
            period: '2024–25',
            release: '2026-08-19',
          } as Figure,
        },
      ]);
      expect(svg, reason).toMatch(/>Not published[: ]/u);
    }
    expect(formatNotPublished('not_published_by_aihw')).toContain('Australian Institute');
  });

  it('gives a state with no median wait a not reported row', () => {
    const bars = stateBars(
      [
        { state: 'Vic', measures: { median_wait: published(68) } },
        { state: 'Tas', measures: {} },
      ],
      '2024–25',
      '2026-08-19',
    );
    expect(bars.map((bar) => bar.name)).toEqual(['Victoria', 'Tasmania']);
    expect(bars[1]?.figure.state).toBe('not_reported');
    expect(chart(bars)).toContain('>Not reported<');
  });
});
