import { describe, expect, it } from 'vitest';
import { normalise, rank } from './match';
import { nearest } from './nearest';

const items = [
  { fields: [normalise('Knee replacement'), normalise('total knee replacement')] },
  {
    fields: [normalise('Cataract surgery'), normalise('cataracts'), normalise('cataract removal')],
  },
  { fields: [normalise('Hip replacement'), normalise('hip joint')] },
];

describe('the tool search', () => {
  it('finds a surgery by its name and by an everyday word', () => {
    expect(rank(items, 'cataract', 5)[0]?.item).toBe(items[1]);
    expect(rank(items, 'cataracts', 5)[0]).toMatchObject({ item: items[1], field: 1 });
    expect(rank(items, 'knee', 5).map((r) => r.item)).toEqual([items[0]]);
  });

  it('puts a name that starts with the query before a word found inside one', () => {
    expect(rank(items, 'replacement', 5).map((r) => r.item)).toEqual([items[0], items[2]]);
    expect(rank(items, 'total', 5)[0]).toMatchObject({ item: items[0], field: 1 });
  });

  it('ignores case, accents and punctuation, and finds nothing for an empty query', () => {
    expect(normalise('  Café-Ünit  ')).toBe('cafe unit');
    expect(rank(items, '   ', 5)).toEqual([]);
    expect(rank(items, 'zzz', 5)).toEqual([]);
  });

  it('holds the list to the limit', () => {
    expect(rank(items, 'e', 2)).toHaveLength(2);
  });
});

describe('the nearest hospitals', () => {
  const at = (
    hospital: number,
    latitude: number,
    longitude: number,
  ): { hospital: number; latitude: number; longitude: number } => ({
    hospital,
    latitude,
    longitude,
  });

  it('orders by great-circle distance and breaks a tie by hospital order', () => {
    const rows = [at(2, -33.9, 151.2), at(0, -34.4, 150.9), at(1, -33.9, 151.2)];
    const found = nearest(rows, { latitude: -33.86, longitude: 151.2 }, 3);
    expect(found.map((f) => f.row.hospital)).toEqual([1, 2, 0]);
    expect(found[0]?.km).toBeCloseTo(4.4, 1);
  });

  it('keeps only the number asked for', () => {
    const rows = [at(0, 0, 0), at(1, 0, 1), at(2, 0, 2)];
    expect(nearest(rows, { latitude: 0, longitude: 0 }, 2)).toHaveLength(2);
  });
});
