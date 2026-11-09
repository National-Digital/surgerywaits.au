import { describe, expect, it } from 'vitest';

import ProofStrip from '../components/ProofStrip.astro';
import { getHomeTemplate } from './content';
import { proofHeading, proofTiles } from './home-proof';
import type { ProofSource } from './home-proof';
import type { BorderPair, Entry, Move } from './longest-page';
import { stateName } from './state-page';
import { render, textsOf } from './test-render';

const t = getHomeTemplate();
const stamp = { period: '2024–25', release: '2026-08-19' };
const published = (value: number): Entry['figure'] => ({ state: 'published', value, ...stamp });
const ref = { name: 'Hip replacement' } as Entry['ref'];

// Only the fields the strip reads are filled in.
const longest = {
  ref,
  row: { name: 'Box Hill Hospital' },
  figure: published(1236),
} as unknown as Entry;
const pair = (km: number): BorderPair =>
  ({
    ref,
    difference: 427,
    km,
    from: { row: { name: 'Box Hill Hospital', state: 'Vic' } },
    to: { row: { name: 'Albury Hospital', state: 'NSW' } },
  }) as unknown as BorderPair;
const border = pair(95.4);
const move = (from: number, to: number): Move =>
  ({
    ref,
    state: 'Vic',
    from: published(from),
    to: published(to),
    change: to - from,
  }) as unknown as Move;

const source = (over: Partial<ProofSource> = {}): ProofSource => ({
  longest,
  longestCount: 50,
  border,
  move: move(356, 189),
  period: '2024–25',
  previous: '2023–24',
  ...over,
});

describe('proofTiles', () => {
  it('writes the three tiles with a bare number, one unit and the sentence of each source', () => {
    const tiles = proofTiles(t, source());
    expect(tiles.map((tile) => `${tile.amount} ${tile.unit}`)).toEqual([
      '1,236 days',
      '427 days',
      '356 to 189 days',
    ]);
    expect(tiles.map((tile) => tile.href)).toEqual([
      '/longest-waits/',
      '/longest-waits/border/',
      '/longest-waits/changes/',
    ]);
    expect(tiles[0]?.sentence).toBe(
      'Hip replacement at Box Hill Hospital had the longest published median wait in 2024–25.',
    );
    expect(tiles[0]?.link).toBe('See the 50 longest waits');
    expect(tiles[1]?.sentence).toBe(
      'In 2024–25, the published median wait for hip replacement at Albury Hospital in New South Wales was 427 days shorter than at Box Hill Hospital in Victoria. The two hospitals are 95 kilometres apart.',
    );
    expect(tiles[1]?.link).toBe('See the border comparisons');
    expect(tiles[2]?.sentence).toContain(`Hip replacement in ${stateName('Vic')}`);
    expect(tiles[2]?.sentence).toContain('from 2023–24 to 2024–25');
    expect(tiles[2]?.sentence.endsWith('the median wait fell.')).toBe(true);
  });

  it('counts the longest link from the rows the page shows, ties included', () => {
    const [tile] = proofTiles(t, source({ longestCount: 52, border: undefined, move: undefined }));
    expect(tile?.link).toBe('See the 52 longest waits');
  });

  it('says one kilometre in the singular and less than one kilometre under 1', () => {
    const sentence = (km: number): string | undefined =>
      proofTiles(t, source({ longest: undefined, move: undefined, border: pair(km) }))[0]?.sentence;
    expect(sentence(1.2)).toContain('The two hospitals are 1 kilometre apart.');
    expect(sentence(0.3)).toContain('The two hospitals are less than 1 kilometre apart.');
  });

  it('states a fall as a fall and uses the singular unit for one day', () => {
    const [tile] = proofTiles(
      t,
      source({ longest: undefined, border: undefined, move: move(2, 1) }),
    );
    expect([tile?.amount, tile?.unit]).toEqual(['2 to 1', 'day']);
    const [rise] = proofTiles(
      t,
      source({ longest: undefined, border: undefined, move: move(189, 356) }),
    );
    expect(rise?.sentence.endsWith('the median wait rose.')).toBe(true);
    expect(rise?.amount).toBe('189 to 356');
  });

  it('leaves out the move tile when the change is zero days', () => {
    expect(proofTiles(t, source({ move: move(200, 200) })).map((tile) => tile.href)).toEqual([
      '/longest-waits/',
      '/longest-waits/border/',
    ]);
  });

  it('drops a tile whose source is absent and keeps the others in order', () => {
    expect(proofTiles(t, source({ border: undefined })).map((tile) => tile.href)).toEqual([
      '/longest-waits/',
      '/longest-waits/changes/',
    ]);
    expect(proofTiles(t, source({ longest: undefined })).map((tile) => tile.href)).toEqual([
      '/longest-waits/border/',
      '/longest-waits/changes/',
    ]);
    expect(proofTiles(t, source({ move: undefined })).map((tile) => tile.href)).toEqual([
      '/longest-waits/',
      '/longest-waits/border/',
    ]);
  });

  it('returns no tile when every source is absent', () => {
    expect(
      proofTiles(t, source({ longest: undefined, border: undefined, move: undefined })),
    ).toEqual([]);
  });

  it('counts the heading from the tiles shown', () => {
    expect(proofHeading(t, 3)).toBe('Three published figures');
    expect(proofHeading(t, 2)).toBe('Two published figures');
    expect(proofHeading(t, 1)).toBe('One published figure');
  });

  it('refuses a heading for no tile', () => {
    expect(() => proofHeading(t, 0)).toThrow(RangeError);
    expect(() => proofHeading(t, 4)).toThrow(RangeError);
  });
});

describe('ProofStrip', () => {
  it('renders a list with one item for each tile under the matching heading', async () => {
    const tiles = proofTiles(t, source());
    const html = await render(ProofStrip, { heading: proofHeading(t, 3), tiles });
    expect(html.match(/class="c-proof__tile"/g)).toHaveLength(3);
    expect(textsOf(html, 'u-visually-hidden')).toEqual(['Three published figures']);
  });

  it('renders nothing when no tile remains', async () => {
    const html = await render(ProofStrip, { heading: '', tiles: [] });
    expect(html).not.toContain('c-proof');
  });
});
