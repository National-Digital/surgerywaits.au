import { describe, expect, it } from 'vitest';

import { listDist } from './dist';
import type { Hospital, SurgeryRow, Trend } from './dist';
import {
  history,
  indexablePairPaths,
  isThin,
  loadPair,
  pairPath,
  pairRoutes,
  shorterNearby,
  thinPairPaths,
} from './pair-page';
import { refOf } from './surgery-page';

// Addresses from the earlier site's sitemap, so a changed slug cannot slip past.
const EARLIER_INDEXABLE = [
  '/hospital/armidale-hospital/arthroscopy/',
  '/hospital/armidale-hospital/carpal-tunnel-surgery/',
  '/hospital/armidale-hospital/cataract-surgery/',
];
// Pages the earlier site built and asked search engines to skip.
const EARLIER_THIN = [
  '/hospital/armidale-hospital/acl-reconstruction/',
  '/hospital/wollongong-hospital/arthrodesis/',
];

const all = (): string[] =>
  pairRoutes().map(({ params }) => `/hospital/${params.slug}/${params.surgery}/`);

describe('Pair addresses', () => {
  it('follow /hospital/<hospital>/<surgery>/ and use the surgery page slug', () => {
    expect(pairPath('albany-hospital', refOf('procedure', 'hip-replacement'))).toBe(
      '/hospital/albany-hospital/hip-replacement/',
    );
    expect(pairPath('albany-hospital', refOf('procedure', 'blepharoplasty'))).toBe(
      '/hospital/albany-hospital/blepharoplasty/',
    );
  });

  it('include every address the earlier site built, thin or not, and no duplicates', () => {
    const paths = all();
    expect(new Set(paths).size).toBe(paths.length);
    for (const address of [...EARLIER_INDEXABLE, ...EARLIER_THIN]) {
      expect(paths).toContain(address);
    }
  });

  it('build a page only for a hospital and a procedure that exist', () => {
    const hospitals = new Set(listDist('hospitals'));
    for (const { props } of pairRoutes()) {
      expect(hospitals.has(props.slug)).toBe(true);
      expect(() => refOf('procedure', props.surgery)).not.toThrow();
    }
  });
});

describe('The thin-page rule', () => {
  it('keeps the earlier site split between pages to index and pages to skip', () => {
    for (const address of EARLIER_INDEXABLE) {
      expect(indexablePairPaths()).toContain(address);
    }
    for (const address of EARLIER_THIN) {
      expect(thinPairPaths()).toContain(address);
    }
  });

  it('splits every pair into exactly one of the two lists', () => {
    expect([...indexablePairPaths(), ...thinPairPaths()].sort()).toEqual(all().sort());
  });

  it('marks every pair with no published median as thin', () => {
    const pairs = pairRoutes().map(({ props }) => loadPair(props.slug, props.surgery));
    const unpublished = pairs.filter(
      (p) => p.row.measures.median_wait?.figure.state !== 'published',
    );
    expect(unpublished.length).toBeGreaterThan(0);
    expect(unpublished.every((p) => p.thin)).toBe(true);
  });

  const base = (): ReturnType<typeof loadPair> => {
    const found = pairRoutes()
      .map(({ props }) => loadPair(props.slug, props.surgery))
      .find((p) => !p.thin);
    if (found === undefined) {
      throw new Error('the fixture has no page to index');
    }
    return found;
  };
  const bare = (): {
    surgery: ReturnType<typeof loadPair>['surgery'];
    row: ReturnType<typeof loadPair>['row'];
  } => {
    const { surgery, row } = structuredClone(base());
    surgery.benchmarks.national = null;
    return { surgery, row };
  };
  const trend = (periods: string[]): Trend => ({
    sources: [],
    series: [
      {
        kind: 'procedure',
        slug: base().ref.slug,
        role: 'median_wait',
        release: '2026-08-19',
        periods,
        points: periods.map((_, i) => [2020 + i, 10, null] as const),
      },
    ],
  });

  it('calls a published median with nothing else to say thin, and any one extra signal enough', () => {
    const { ref } = base();
    const { surgery, row } = bare();
    const none = { trend: undefined, ref, nearby: null, area: null };
    expect(isThin(surgery, row, none)).toBe(true);
    expect(isThin(surgery, row, { ...none, area: 'Armidale' })).toBe(false);
    expect(isThin(surgery, row, { ...none, trend: trend(['2023–24', surgery.period]) })).toBe(
      false,
    );
    expect(isThin(surgery, row, { ...none, trend: trend([surgery.period, '2030–31']) })).toBe(
      false,
    );
    expect(isThin(surgery, row, { ...none, trend: trend([surgery.period]) })).toBe(true);
  });

  it('calls a withheld median thin whatever else the page holds', () => {
    const { surgery, row } = structuredClone(base());
    row.measures.median_wait = {
      figure: {
        state: 'not_published',
        reason: 'too_few_patients',
        period: surgery.period,
        release: surgery.release,
      },
      rank: { status: 'unranked', why: 'not_published' },
    };
    expect(
      isThin(surgery, row, {
        trend: undefined,
        ref: base().ref,
        nearby: null,
        area: 'Armidale',
      }),
    ).toBe(true);
  });

  describe('with a neighbour in the mesh', () => {
    const found = (): ReturnType<typeof loadPair> => {
      const pair = structuredClone(
        pairRoutes()
          .map(({ props }) => loadPair(props.slug, props.surgery))
          .find((p) => !p.thin && p.row.measures.median_wait?.figure.state === 'published'),
      );
      if (pair === undefined) {
        throw new Error('the fixture has no page to index');
      }
      pair.surgery.benchmarks.national = null;
      return pair;
    };
    const neighbour = (row: SurgeryRow, change: (n: SurgeryRow) => void): SurgeryRow => {
      const other = { ...structuredClone(row), code: 'SYN1', slug: 'syn-one', name: 'Syn One' };
      change(other);
      return other;
    };
    const mesh = (codes: string[]): Hospital['nearby'] => ({
      radius_km: 250,
      hospitals: codes.map((code) => ({ code, name: code, slug: null, distance_km: 5 })),
    });
    const thinWith = (codes: string[], change: (n: SurgeryRow) => void, own = false): boolean => {
      const pair = found();
      const other = neighbour(pair.row, change);
      pair.surgery.hospitals.push(other);
      pair.row.closed = own;
      return isThin(pair.surgery, pair.row, {
        trend: undefined,
        ref: pair.ref,
        nearby: mesh(codes),
        area: null,
      });
    };
    const same = (): void => undefined;

    it('is rescued by an open, current neighbour with a published median in the mesh', () => {
      expect(thinWith(['SYN1'], same)).toBe(false);
    });

    it('is not rescued by a neighbour outside the mesh, however many rows the surgery has', () => {
      expect(thinWith(['OTHER'], same)).toBe(true);
      expect(thinWith([], same)).toBe(true);
    });

    it('is not rescued by a closed neighbour', () => {
      expect(thinWith(['SYN1'], (n) => (n.closed = true))).toBe(true);
    });

    it('is not rescued by a neighbour with a withheld median or one from an earlier period', () => {
      expect(
        thinWith(['SYN1'], (n) => {
          n.measures.median_wait = {
            figure: {
              state: 'not_published',
              reason: 'too_few_patients',
              period: n.measures.median_wait?.figure.period ?? '',
              release: n.measures.median_wait?.figure.release ?? '',
            },
            rank: { status: 'unranked', why: 'not_published' },
          };
        }),
      ).toBe(true);
      expect(
        thinWith(['SYN1'], (n) => {
          for (const measure of Object.values(n.measures)) {
            measure.figure.period = '1999–00';
          }
        }),
      ).toBe(true);
    });

    it('is not rescued when its own hospital has closed, and has no mesh when it has no location', () => {
      expect(thinWith(['SYN1'], same, true)).toBe(true);
      const pair = found();
      expect(
        isThin(pair.surgery, pair.row, {
          trend: undefined,
          ref: pair.ref,
          nearby: null,
          area: null,
        }),
      ).toBe(true);
    });

    it('lists only the mesh hospitals with a shorter published median, nearest first', () => {
      const pair = found();
      const own = pair.row.measures.median_wait?.figure;
      if (own?.state !== 'published') {
        throw new Error('the pair has no median');
      }
      const make = (code: string, value: number): SurgeryRow => {
        const row = neighbour(pair.row, (n) => {
          n.code = code;
          n.slug = code.toLowerCase();
          const measure = n.measures.median_wait;
          if (measure !== undefined) {
            measure.figure = { ...own, value };
          }
        });
        return row;
      };
      pair.surgery.hospitals.push(make('A', own.value - 1), make('B', own.value + 1));
      pair.hospital.nearby = mesh(['B', 'A', 'MISSING']);
      expect(shorterNearby(pair)?.map((n) => n.name)).toEqual(['A']);
      pair.hospital.nearby = null;
      expect(shorterNearby(pair)).toBeNull();
    });

    it('tells the history from the earliest other published year', () => {
      const pair = found();
      const own = pair.row.measures.median_wait?.figure;
      if (own?.state !== 'published') {
        throw new Error('the pair has no median');
      }
      pair.trend = trend(['2016–17', pair.surgery.period]);
      const told = history(pair);
      expect(told?.from.period).toBe('2016–17');
      expect(told?.from.release).toBe('2026-08-19');
      expect(told?.direction).toBe(own.value > 10 ? 'rose' : own.value < 10 ? 'fell' : 'unchanged');
      pair.trend = trend([pair.surgery.period]);
      expect(history(pair)).toBeNull();
    });
  });
});
