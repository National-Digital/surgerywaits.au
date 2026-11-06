import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listSurgeries, readSurgery } from './dist';
import type { Surgery } from './dist';
import { cleanUpCopies, withNearbyPair, withSpoiledRow } from './test-dist';
import type { Spoil } from './test-dist';
import {
  benchmarkCells,
  busiestStates,
  hospitalRows,
  hubRoutes,
  isCurrent,
  listable,
  nearAreas,
  nearPath,
  nearRoutes,
  refOf,
  slugify,
  stateRoutes,
  statePath,
  surgeryPath,
  surgeryRefs,
  trendScope,
} from './surgery-page';

afterEach(() => {
  vi.unstubAllEnvs();
  cleanUpCopies();
});

function fail(message: string): never {
  throw new Error(message);
}

describe('Surgery addresses', () => {
  it('keep the earlier site address where an everyday name earned one', () => {
    expect(surgeryPath(refOf('procedure', 'hip-replacement'))).toBe('/surgery/hip-replacement/');
    expect(refOf('procedure', 'hip-replacement').slug).toBe('total-hip-replacement');
    expect(refOf('procedure', 'acl-reconstruction').slug).toBe(
      'anterior-cruciate-ligament-reconstruction',
    );
    expect(refOf('procedure', 'blepharoplasty').slug).toBe('blepharoplasty');
    expect(() => refOf('procedure', 'total-hip-replacement')).toThrow(RangeError);
  });

  it('give specialties their own directory so no address can collide', () => {
    expect(surgeryPath(refOf('specialty', 'orthopaedic-surgery'))).toBe(
      '/specialty/orthopaedic-surgery/',
    );
    const paths = surgeryRefs().map(surgeryPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('write a state address in lower case and a place address as a slug', () => {
    const ref = refOf('procedure', 'hip-replacement');
    expect(statePath(ref, 'NSW')).toBe('/surgery/hip-replacement/nsw/');
    expect(statePath(ref, 'Vic')).toBe('/surgery/hip-replacement/vic/');
    expect(nearPath(ref, slugify('St Leonards'))).toBe(
      '/surgery/hip-replacement/near/st-leonards/',
    );
    expect(slugify('Adelaide CBD')).toBe('adelaide-cbd');
  });

  it('give a state page only to a state with a hospital row', () => {
    const states = stateRoutes('procedure').filter((r) => r.props.slug === 'hip-replacement');
    expect(states.map((r) => r.params.state)).toEqual(['act', 'nsw', 'qld', 'vic']);
    expect(hubRoutes('procedure')).toHaveLength(listSurgeries('procedure').length);
    expect(hubRoutes('specialty')).toHaveLength(listSurgeries('specialty').length);
  });
});

describe('Hospital rows', () => {
  const surgery = readSurgery('procedure', 'total-hip-replacement');

  it('order by the measured median, with a withheld row last and unranked', () => {
    const withheld = structuredClone(surgery.hospitals[0] ?? fail('the fixture has no hospital'));
    withheld.measures.median_wait = {
      figure: {
        state: 'not_published',
        reason: 'too_few_patients',
        period: surgery.period,
        release: surgery.release,
      },
      rank: { status: 'unranked', why: 'not_published' },
    };
    const model = hospitalRows(surgery, [withheld, ...surgery.hospitals.slice(1)]);
    const rows = model?.rows ?? [];
    const medians = rows.map((row) => {
      const figure = row.cells[0]?.figure;
      return figure?.state === 'published' ? figure.value : null;
    });
    const published = medians.slice(0, -1);
    expect(published).toEqual([...published].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(medians.at(-1)).toBeNull();
    expect(rows.at(-1)?.code).toBe(withheld.slug);
    for (const row of rows) {
      for (const cell of row.cells) {
        expect(cell.figure.state !== 'published' && cell.rank !== undefined).toBe(false);
      }
    }
    expect(rows.slice(0, -1).every((r) => r.cells[0]?.rank !== undefined)).toBe(true);
  });

  it('treat a row from another period as earlier and never rank it', () => {
    const [first = fail('the fixture has no hospital'), ...rest] = surgery.hospitals;
    const older = structuredClone(first);
    for (const m of Object.values(older.measures)) {
      m.figure.period = '2022–23';
    }
    expect(isCurrent(older, surgery)).toBe(false);
    const model = hospitalRows(surgery, [older, ...rest]);
    const row = model?.rows.find((r) => r.code === older.slug);
    expect(row?.stale).toBe(true);
    expect(row?.cells.every((c) => c.rank === undefined)).toBe(true);
  });

  it('give no table when no hospital reports the surgery', () => {
    expect(hospitalRows(surgery, [])).toBeNull();
  });
});

describe('Benchmarks', () => {
  const surgery = readSurgery('procedure', 'total-hip-replacement');

  it('read "not reported" for a measure the source left out, with the table period', () => {
    const cells = benchmarkCells(surgery, {
      median_wait: surgery.benchmarks.national?.median_wait as never,
    });
    expect(cells.map((c) => c.figure.state)).toEqual(['published', 'not_reported', 'not_reported']);
    expect(cells[1]?.figure.period).toBe(surgery.period);
    expect(benchmarkCells(surgery, null).every((c) => c.figure.state === 'not_reported')).toBe(
      true,
    );
  });

  it('chart Australia with the states that treated the most patients, by volume', () => {
    expect(busiestStates(surgery)).toEqual(['NSW', 'Qld', 'Vic']);
    const charts = trendScope(surgery, ['NAT', 'NSW'], {
      NAT: 'Australia',
      NSW: 'New South Wales',
    });
    expect(charts.flatMap((c) => c.series.map((s) => s.name))).toEqual([
      'Australia',
      'New South Wales',
    ]);
  });
});

describe('Nearby places', () => {
  it('form no page in the plain fixtures, because no two hospitals of a place report one surgery', () => {
    expect(nearRoutes()).toEqual([]);
  });

  it('list the hospitals of one network near its main hospital, ranked ones first', () => {
    withNearbyPair();
    const routes = nearRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(routes.map((r) => r.params.area))).toEqual(new Set(['wollongong']));
    const area = nearAreas().get('hip-replacement')?.[0];
    expect(area?.state).toBe('NSW');
    expect(area?.rows.map((r) => r.code).sort()).toEqual(['H0041', 'H0047']);
    expect(area?.hasOutside).toBe(false);
  });

  it('leave a place out when too few surgeries give it a page', () => {
    const copy = withNearbyPair();
    for (const slug of listSurgeries('procedure').slice(0, 200)) {
      const file = join(copy, `surgeries/procedure/${slug}.json`);
      const surgery = JSON.parse(readFileSync(file, 'utf8')) as Surgery;
      surgery.hospitals = surgery.hospitals.filter((h) => h.code !== 'H0041');
      writeFileSync(file, JSON.stringify(surgery));
    }
    expect(nearRoutes()).toEqual([]);
  });
});

describe('A hospital that cannot be ranked', () => {
  const SLUG = 'total-hip-replacement';
  const PAGE = 'hip-replacement';
  const spoils: Spoil[] = ['closed', 'stale', 'withheld'];

  it.each(spoils)('leaves a %s hospital out of the pair that makes a near page', (spoil) => {
    withNearbyPair();
    expect(
      nearAreas()
        .get(PAGE)
        ?.map((a) => a.slug),
    ).toContain('wollongong');
    vi.unstubAllEnvs();
    cleanUpCopies();
    withSpoiledRow(SLUG, 'H0041', spoil);
    const areas = nearAreas();
    // Two ranked hospitals make a page, so one that cannot be ranked leaves this surgery without it.
    expect(areas.get(PAGE)?.map((a) => a.slug) ?? []).not.toContain('wollongong');
    expect(areas.get('knee-replacement')?.map((a) => a.slug)).toContain('wollongong');
  });

  it.each(spoils)('never ranks or lists a %s hospital as ranked on a hub', (spoil) => {
    withSpoiledRow(SLUG, 'H0041', spoil);
    const surgery = readSurgery('procedure', SLUG);
    const rows = hospitalRows(surgery, listable(surgery))?.rows ?? [];
    const row = rows.find((r) => r.code === 'bulli-hospital');
    if (spoil === 'closed') {
      expect(row).toBeUndefined();
      return;
    }
    expect(row).toBeDefined();
    const medians = row?.cells.map((c) => c.rank) ?? [];
    expect(medians.every((rank) => rank === undefined)).toBe(true);
    expect(row?.stale).toBe(spoil === 'stale');
  });
});
