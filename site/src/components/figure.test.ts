import { describe, expect, it } from 'vitest';
import type { Figure as FigureData, NotPublishedReason, QueenslandFigure } from '../lib/format';
import { render, text, textsOf } from '../lib/test-render';
import Figure from './Figure.astro';

const stamp = { period: '2024–25', release: '2026-08-19' };
const STAMP_TEXT = '2024–25, released 19 August 2026';
const quarter = { period: 'July to September 2025', release: '2025-10-28' };

const words: Record<NotPublishedReason, string> = {
  too_few_patients: 'not published: too few patients',
  no_patients_reported: 'not published: no patients reported',
  not_published_by_aihw: 'not published: AIHW did not publish a figure',
  no_peer_group_comparison: 'not published: no peer group comparison',
  not_given_by_queensland_health: 'not published: Queensland Health gave no figure',
};

const published = (value: number): FigureData => ({ state: 'published', value, ...stamp });

describe('Figure', () => {
  it.each(Object.entries(words))(
    'renders its words for %s, never 0 or blank',
    async (reason, expected) => {
      const html = await render(Figure, {
        role: 'median_wait',
        figure: { state: 'not_published', reason, ...stamp },
      });
      const [value] = textsOf(html, 'c-figure__value');
      expect(value).toBe(expected);
      expect(value).not.toMatch(/\d/);
    },
  );

  it('renders not reported in words with no number', async () => {
    const html = await render(Figure, {
      role: 'volume',
      figure: { state: 'not_reported', reason: 'not_reported_by_source', ...stamp },
    });
    expect(textsOf(html, 'c-figure__value')).toEqual(['not reported']);
  });

  it.each([
    ['median_wait', '0 days'],
    ['volume', '0 surgeries'],
    ['on_time', '0%'],
    ['long_wait', '0.0%'],
  ] as const)('renders a published zero for %s as %s', async (role, expected) => {
    const html = await render(Figure, { role, figure: published(0) });
    expect(textsOf(html, 'c-figure__value')).toEqual([expected]);
  });

  it('marks a withheld figure with the not-published class and a published one without', async () => {
    const withheld = await render(Figure, {
      role: 'median_wait',
      figure: { state: 'not_published', reason: 'too_few_patients', ...stamp },
    });
    expect(withheld).toContain('is-not-published');
    const shown = await render(Figure, { role: 'median_wait', figure: published(328) });
    expect(shown).not.toContain('is-not-published');
  });

  it('sets the unit apart from the number', async () => {
    const html = await render(Figure, { role: 'median_wait', figure: published(328) });
    expect(textsOf(html, 'c-figure__value')).toEqual(['328 days']);
    expect(textsOf(html, 'c-figure-unit')).toEqual(['days']);
  });

  it.each([
    published(13),
    { state: 'not_published', reason: 'too_few_patients', ...stamp },
    { state: 'not_reported', reason: 'not_reported_by_source', ...stamp },
  ] as FigureData[])('always carries the stamp, for a $state figure', async (figure) => {
    const html = await render(Figure, { role: 'median_wait', figure });
    expect(textsOf(html, 'c-stamp')).toEqual([STAMP_TEXT]);
  });

  it.each([
    ['no reference period', { state: 'published', value: 5, release: stamp.release }],
    ['a blank reference period', { ...published(5), period: ' ' }],
    ['no release date', { state: 'published', value: 5, period: stamp.period }],
    ['an impossible release date', { ...published(5), release: '2026-02-30' }],
    ['a release date that is not ISO', { ...published(5), release: '19 August 2026' }],
  ])('fails the build for a figure with %s', async (_name, figure) => {
    await expect(render(Figure, { role: 'median_wait', figure })).rejects.toThrow();
  });

  it('fails the build for a figure that cannot state its period and release', async () => {
    const figures = [
      { state: 'published', value: 5, release: stamp.release },
      { state: 'published', value: 5, period: stamp.period },
      { state: 'not_reported', reason: 'not_reported_by_source', period: stamp.period },
    ];
    for (const figure of figures) {
      await expect(render(Figure, { role: 'median_wait', figure })).rejects.toThrow();
    }
  });

  it('fails the build for a reason it has no words for', async () => {
    await expect(
      render(Figure, {
        role: 'median_wait',
        figure: { state: 'not_published', reason: 'unknown_marker', ...stamp },
      }),
    ).rejects.toThrow(RangeError);
  });

  describe('on the Queensland scale', () => {
    const figure = (value: number): QueenslandFigure => ({
      state: 'published',
      value,
      ...quarter,
    });

    it('reads a percentage as a percentage of 100 and a count as a plain count', async () => {
      const percent = await render(Figure, {
        column: 'percent_treated_in_time',
        figure: figure(88.3),
      });
      expect(textsOf(percent, 'c-figure__value')).toEqual(['88.3%']);
      const count = await render(Figure, { column: 'treated', figure: figure(2713) });
      expect(textsOf(count, 'c-figure__value')).toEqual(['2,713']);
      const change = await render(Figure, {
        column: 'percent_change_treated_on_prior_year',
        figure: figure(20.3),
      });
      expect(textsOf(change, 'c-figure__value')).toEqual(['+20.3%']);
    });

    it('states the quarter and the release date', async () => {
      const html = await render(Figure, { column: 'treated', figure: figure(4) });
      expect(textsOf(html, 'c-stamp')).toEqual([
        'July to September 2025, released 28 October 2025',
      ]);
    });

    it('renders a figure Queensland Health withheld in words', async () => {
      const html = await render(Figure, {
        column: 'treated',
        figure: { state: 'not_published', reason: 'not_given_by_queensland_health', ...quarter },
      });
      expect(text(html)).toContain('not published: Queensland Health gave no figure');
      expect(textsOf(html, 'c-figure__value')[0]).not.toMatch(/\d/);
    });
  });
});
