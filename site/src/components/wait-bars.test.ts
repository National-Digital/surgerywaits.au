import { describe, expect, it } from 'vitest';
import type { Figure } from '../lib/format';
import { render, textsOf } from '../lib/test-render';
import WaitBars from './WaitBars.astro';

const stamp = { period: '2024–25', release: '2026-08-19' };
const published = (value: number): Figure => ({ state: 'published', value, ...stamp });
const withheld: Figure = { state: 'not_published', reason: 'too_few_patients', ...stamp };
const bars = [
  { name: 'Alpha Hospital', figure: published(20) },
  { name: 'Beta Hospital', figure: withheld },
  { name: 'Gamma Hospital', figure: published(0) },
  { name: 'Delta Hospital', figure: published(80) },
];
const props = { id: 'w', caption: 'Median wait', role: 'median_wait', bars };

describe('WaitBars', () => {
  it('keeps the order it is given and labels every bar with its value', async () => {
    const html = await render(WaitBars, props);
    expect(textsOf(html, 'c-waits__label')).toEqual([
      'Alpha Hospital',
      'Beta Hospital',
      'Gamma Hospital',
      'Delta Hospital',
    ]);
    expect(textsOf(html, 'c-waits__value')).toEqual([
      '20 days',
      'not published: too few patients',
      '0 days',
      '80 days',
    ]);
  });

  it('draws no bar for a withheld value', async () => {
    const html = await render(WaitBars, props);
    expect(html.match(/<svg/g)).toHaveLength(3);
    expect(html.match(/c-wait-bar__fill/g)).toHaveLength(3);
    const items = html.split('<li').slice(1);
    expect(items[1]).not.toContain('<svg');
    expect(items[1]).toContain('is-not-published');
  });

  it('scales bars to the largest value and marks a published zero', async () => {
    const html = await render(WaitBars, props);
    const widths = [...html.matchAll(/c-wait-bar__fill.[^>]*width=.([\d.]+)/g)].map((m) => m[1]);
    expect(widths).toEqual(['25.0', '0.0', '100.0']);
    expect(html.match(/c-wait-bar__marker/g)).toHaveLength(1);
  });

  it('gives any positive value a visible width and keeps the marker for a published zero', async () => {
    const tiny = [
      { name: 'Tiny', figure: published(0.01) },
      { name: 'Zero', figure: published(0) },
      { name: 'Big', figure: published(100) },
    ];
    const html = await render(WaitBars, { ...props, bars: tiny });
    const widths = [...html.matchAll(/c-wait-bar__fill.[^>]*width=.([\d.]+)/g)].map((m) => m[1]);
    expect(widths).toEqual(['3.0', '0.0', '100.0']);
    expect(html.match(/c-wait-bar__marker/g)).toHaveLength(1);
  });

  it('scales a share from 0 to 100 percent, not to the largest bar', async () => {
    const shares = [
      { name: 'A', figure: published(0.1) },
      { name: 'B', figure: published(0.02) },
    ];
    const html = await render(WaitBars, { ...props, role: 'long_wait', bars: shares });
    const widths = [...html.matchAll(/c-wait-bar__fill.[^>]*width=.([\d.]+)/g)].map((m) => m[1]);
    expect(widths).toEqual(['10.0', '3.0']);
  });

  it('scales days to a round maximum above the largest value', async () => {
    const days = [{ name: 'A', figure: published(30) }];
    const html = await render(WaitBars, { ...props, bars: days });
    expect(html).toMatch(/c-wait-bar__fill.[^>]*width="100.0"/);
    const more = [
      { name: 'A', figure: published(30) },
      { name: 'B', figure: published(90) },
    ];
    const w = [
      ...(await render(WaitBars, { ...props, bars: more })).matchAll(
        /c-wait-bar__fill.[^>]*width=.([\d.]+)/g,
      ),
    ].map((m) => m[1]);
    expect(w).toEqual(['30.0', '90.0']);
  });

  it('states the period and release once', async () => {
    const html = await render(WaitBars, props);
    expect(textsOf(html, 'c-waits__stamp')).toEqual(['2024–25, released 19 August 2026']);
  });

  it('is deterministic and ships no script', async () => {
    const html = await render(WaitBars, props);
    expect(html).toBe(await render(WaitBars, props));
    expect(html).not.toMatch(/<script/i);
  });

  it('fails when current bars disagree on their period', async () => {
    const odd = { name: 'Odd', figure: { ...published(5), period: '2023–24' } };
    await expect(render(WaitBars, { ...props, bars: [...bars, odd] })).rejects.toThrow();
  });
});
