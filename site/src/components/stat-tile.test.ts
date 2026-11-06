import { describe, expect, it } from 'vitest';
import type { Figure as FigureData } from '../lib/format';
import { render, text, textsOf } from '../lib/test-render';
import StatTile from './StatTile.astro';

const stamp = { period: '2024–25', release: '2026-08-19' };
const published = (value: number, period = stamp.period): FigureData => ({
  state: 'published',
  value,
  ...stamp,
  period,
});
const EARLIER =
  'This hospital last reported this figure in an earlier period. It is not the latest figure.';

describe('StatTile', () => {
  it('holds its label, a figure with its stamp, a rank and a change', async () => {
    const html = await render(StatTile, {
      heading: 'Median wait',
      role: 'median_wait',
      figure: published(55),
      rank: { position: 3, of: 40 },
      change: 3,
    });
    expect(textsOf(html, 'c-tiles__label')).toEqual(['Median wait']);
    expect(textsOf(html, 'c-figure__value')).toEqual(['55 days']);
    expect(textsOf(html, 'c-stamp')).toEqual(['2024–25, released 19 August 2026']);
    expect(textsOf(html, 'c-tiles__line')).toEqual([
      'Rank 3rd of 40 nationally',
      'Change on the year before +3 days',
    ]);
    expect(text(html)).not.toContain(EARLIER);
  });

  it('leaves out the rank and the change when it has none', async () => {
    const html = await render(StatTile, {
      heading: 'Median wait',
      role: 'median_wait',
      figure: published(55),
    });
    expect(textsOf(html, 'c-tiles__line')).toEqual([]);
  });

  it('shows a stale figure with an earlier period note and its own older period', async () => {
    const html = await render(StatTile, {
      heading: 'Patients treated',
      role: 'volume',
      figure: published(7, '2017–18'),
      stale: true,
    });
    expect(textsOf(html, 'c-tiles__note')).toEqual([EARLIER]);
    expect(html).toContain('c-tiles__earlier');
    expect(textsOf(html, 'c-stamp')).toEqual(['2017–18, released 19 August 2026']);
  });

  it('never ranks or compares a stale figure', async () => {
    const stale = {
      heading: 'Median wait',
      role: 'median_wait',
      figure: published(55),
      stale: true,
    };
    await expect(render(StatTile, { ...stale, rank: { position: 1, of: 9 } })).rejects.toThrow(
      RangeError,
    );
    await expect(render(StatTile, { ...stale, change: 2 })).rejects.toThrow(RangeError);
  });

  it('never ranks or compares a figure the source withheld', async () => {
    const withheld = {
      heading: 'Median wait',
      role: 'median_wait',
      figure: { state: 'not_published', reason: 'too_few_patients', ...stamp },
    };
    await expect(render(StatTile, { ...withheld, rank: { position: 1, of: 9 } })).rejects.toThrow(
      RangeError,
    );
    const html = await render(StatTile, withheld);
    expect(textsOf(html, 'c-figure__value')).toEqual(['not published: too few patients']);
  });

  it('shows a published zero as zero and a negative change with its sign', async () => {
    const html = await render(StatTile, {
      heading: 'Median wait',
      role: 'median_wait',
      figure: published(0),
      change: -1,
    });
    expect(textsOf(html, 'c-figure__value')).toEqual(['0 days']);
    expect(textsOf(html, 'c-tiles__line')).toEqual(['Change on the year before -1 day']);
  });
});
