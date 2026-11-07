import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { assetsOver } from './mcp-fixture';
import {
  argumentProblem,
  CATEGORIES,
  compareHospitals,
  explainUrgency,
  getWait,
  listProcedures,
  SPECS,
  SUBURBS_SOURCE,
  ToolProblem,
} from '../../../worker/mcp-tools';
import type { Reader } from '../../../worker/mcp-tools';

const root = new URL('../../../pipeline/dist-fixture/', import.meta.url);
const asked: string[] = [];
const assets = assetsOver(root, asked);
const read: Reader = async (path) => {
  const response = await assets.fetch(`https://surgerywaits.au${path}`);
  return response.status === 404 ? null : response.json();
};

const CATARACT = 'cataract-extraction-with-or-without-intra-ocular-lens-insertion';
const WITHHELD = 'hysterectomy-abdominal-vaginal-laparoscopic';

describe('surgerywaits_list_procedures', () => {
  it('lists every surgery with a slug, and none of the urgency categories', async () => {
    const all = await listProcedures(read, {});
    expect(all.total).toBeGreaterThan(100);
    expect(all.surgeries.some((s) => s.slug === CATARACT)).toBe(true);
    expect(all.surgeries.every((s) => s.kind !== 'urgency')).toBe(true);
  });

  it('finds a surgery by the start of a word in its name', async () => {
    const found = await listProcedures(read, { query: 'catar' });
    expect(found.surgeries.map((s) => s.slug)).toContain(CATARACT);
    expect((await listProcedures(read, { query: 'zzzz' })).total).toBe(0);
  });
});

describe('surgerywaits_get_wait', () => {
  it('gives a national figure with its period, release and credit', async () => {
    const answer = await getWait(read, { procedure: 'cataract' });
    expect(answer.scope).toBe('national');
    expect(answer.median_wait).toMatchObject({
      status: 'published',
      value: 106,
      period: '2024–25',
      release: '2026-08-19',
    });
    expect(answer.source.credits.length).toBeGreaterThan(0);
  });

  it('gives a state figure, accepting any case and the full name', async () => {
    for (const state of ['nsw', 'NSW', 'New South Wales']) {
      const answer = await getWait(read, { procedure: CATARACT, state });
      expect(answer).toMatchObject({ scope: 'state', state: 'NSW' });
      expect(answer.median_wait).toMatchObject({ status: 'published', value: 268 });
    }
  });

  it('gives a hospital figure and its page', async () => {
    const answer = await getWait(read, { procedure: CATARACT, hospital: 'armidale' });
    expect(answer).toMatchObject({
      scope: 'hospital',
      page_url: 'https://surgerywaits.au/hospital/armidale-hospital/',
    });
  });

  it('returns a withheld figure as not published with its reason and no number', async () => {
    const answer = await getWait(read, { procedure: WITHHELD, hospital: 'armidale-hospital' });
    expect(answer.median_wait).toEqual({
      status: 'not_published',
      value: null,
      reason: 'not_published_by_aihw',
      display:
        'not published: the Australian Institute of Health and Welfare did not publish a figure',
      period: '2024–25',
      release: '2026-08-19',
    });
    expect(JSON.stringify(answer.median_wait)).not.toMatch(/"value":\s*\d/u);
  });

  it('says when a surgery, hospital or state is not known', async () => {
    await expect(getWait(read, { procedure: 'xyzzy' })).rejects.toThrow(ToolProblem);
    await expect(getWait(read, { procedure: CATARACT, hospital: 'nowhere' })).rejects.toThrow(
      /No public hospital/u,
    );
    await expect(getWait(read, { procedure: CATARACT, state: 'Atlantis' })).rejects.toThrow(
      /not an Australian state/u,
    );
    await expect(getWait(read, { procedure: 'repair' })).rejects.toThrow(/More than one surgery/u);
  });
});

describe('surgerywaits_compare_hospitals', () => {
  it('ranks the published medians near a suburb, shortest first, with distances', async () => {
    // The fixture hospitals are far apart, so one is moved to about 100 km from Armidale.
    const moved: Reader = async (path) => {
      const found = (await read(path)) as {
        hospitals?: { slug: string; latitude: number | null }[];
      } | null;
      for (const row of found?.hospitals ?? []) {
        if (row.slug === 'wollongong-hospital') {
          row.latitude = -31.4;
        }
      }
      return found;
    };
    const answer = await compareHospitals(moved, {
      procedure: 'total-knee-replacement',
      locality: 'Armidale',
      radius_km: 250,
    });
    expect(answer.from).toEqual({ locality: 'Armidale', state: 'NSW' });
    expect(answer.ranked.map((row) => row.name)).toEqual([
      'Armidale Hospital',
      'Wollongong Hospital',
    ]);
    expect(answer.ranked.map((row) => row.rank)).toEqual([1, 2]);
    expect(answer.ranked[0]?.distance_km).toBeLessThan(5);
    expect(answer.ranked[1]?.distance_km).toBeGreaterThan(90);
  });

  it('lists a withheld figure apart, without a rank or a number', async () => {
    const answer = await compareHospitals(read, {
      procedure: WITHHELD,
      locality: 'Armidale',
      radius_km: 5,
    });
    expect(answer.ranked).toEqual([]);
    expect(answer.not_ranked[0]).toMatchObject({
      reason: 'not_published',
      median_wait: { status: 'not_published', value: null },
    });
  });

  it('keeps to the limit and refuses a postcode, an unknown place and a repeated name', async () => {
    const one = await compareHospitals(read, {
      procedure: CATARACT,
      locality: 'Armidale',
      radius_km: 5,
      limit: 1,
    });
    expect(one.ranked).toHaveLength(1);
    await expect(compareHospitals(read, { procedure: CATARACT, locality: '2350' })).rejects.toThrow(
      /Postcodes/u,
    );
    await expect(
      compareHospitals(read, { procedure: CATARACT, locality: 'Nowhereville' }),
    ).rejects.toThrow(/No suburb/u);
    await expect(
      compareHospitals(read, { procedure: CATARACT, locality: 'Abbotsford' }),
    ).rejects.toThrow(/More than one/u);
    expect(
      (await compareHospitals(read, { procedure: CATARACT, locality: 'Abbotsford', state: 'Vic' }))
        .from.state,
    ).toBe('Vic');
  });
});

// A small published world: one surgery, one suburb at -30.5, 150 and the hospitals given.
interface Place {
  code: string;
  latitude: number;
  longitude: number;
  median: { state: string; value?: number; period?: string; reason?: string };
}
const PERIOD = '2024–25';
function world(places: Place[], creditSlugs: string[] = ['src', SUBURBS_SOURCE]): Reader {
  const files: Record<string, unknown> = {
    '/data-api/surgeries.json': {
      surgeries: [{ kind: 'procedure', slug: 'test-surgery', name: 'Test surgery', hospitals: 1 }],
    },
    '/data-api/surgeries/procedure/test-surgery.json': {
      kind: 'procedure',
      slug: 'test-surgery',
      name: 'Test surgery',
      period: PERIOD,
      release: '2026-08-19',
      sources: ['src'],
      benchmarks: { national: null, states: [] },
      hospitals: places.map((p) => ({
        code: p.code,
        slug: p.code.toLowerCase(),
        name: `Hospital ${p.code}`,
        state: 'NSW',
        closed: false,
        measures: {
          median_wait: {
            figure: { period: PERIOD, release: '2026-08-19', ...p.median },
          },
        },
      })),
    },
    '/data-api/hospitals.json': {
      hospitals: places.map((p) => ({
        code: p.code,
        slug: p.code.toLowerCase(),
        name: `Hospital ${p.code}`,
        state: 'NSW',
        closed: false,
        latitude: p.latitude,
        longitude: p.longitude,
      })),
    },
    '/data-api/suburbs.json': { suburbs: [['1', 'Origin', 'NSW', -30.5, 150]] },
    '/data-api/credits.json': {
      sources: creditSlugs.map((slug) => ({
        slug,
        title: slug,
        attribution: slug,
        licence: 'CC-BY-4.0',
        dataset_url: `https://publicdata.au/d/${slug}/`,
      })),
    },
  };
  return (path) => Promise.resolve(files[path] ?? null);
}
const published = (value: number, period?: string): Place['median'] => ({
  state: 'published',
  value,
  ...(period === undefined ? {} : { period }),
});
const near = (code: string, median: Place['median'], dLon = 0.1): Place => ({
  code,
  latitude: -30.5,
  longitude: 150 + dLon,
  median,
});
const ask = { procedure: 'test-surgery', locality: 'Origin' };

describe('surgerywaits_compare_hospitals ranking and distance', () => {
  it('leaves a median from an earlier period unranked, and the other ranks as they were', async () => {
    const base = [near('A', published(100)), near('C', published(200), 0.2)];
    const older = near('B', published(50, '2023–24'), 0.15);
    const without = await compareHospitals(world(base), ask);
    const withOlder = await compareHospitals(world([...base, older]), ask);
    expect(withOlder.ranked.map((row) => [row.name, row.rank])).toEqual([
      ['Hospital A', 1],
      ['Hospital C', 2],
    ]);
    expect(withOlder.ranked).toEqual(without.ranked);
    expect(withOlder.not_ranked).toHaveLength(1);
    expect(withOlder.not_ranked[0]).toMatchObject({
      name: 'Hospital B',
      reason: 'older_period',
    });
  });

  it('measures the great-circle distance, not a flat approximation', async () => {
    // One degree of longitude at -30.5 is 96 km on the sphere and 111 km on a flat map.
    const phi = (-30.5 * Math.PI) / 180;
    const half = Math.sin((1 * Math.PI) / 180 / 2);
    const haversine = 2 * 6371 * Math.asin(Math.cos(phi) * half);
    const flat = (Math.PI / 180) * 6371;
    expect(Math.round(haversine)).toBe(96);
    expect(Math.round(flat)).toBe(111);
    const answer = await compareHospitals(world([near('A', published(100), 1)]), ask);
    expect(answer.ranked[0]?.distance_km).toBe(96);
  });

  it('adds the suburb source to the credits, and fails when a credit is missing', async () => {
    const places = [near('A', published(100))];
    const answer = await compareHospitals(world(places), ask);
    expect(answer.source.credits.map((credit) => credit.title)).toEqual(['src', SUBURBS_SOURCE]);
    await expect(compareHospitals(world(places, ['src']), ask)).rejects.toThrow(
      `no credit for ${SUBURBS_SOURCE}`,
    );
  });
});

describe('a withheld wire figure', () => {
  it('has no number in the output even when the file carries one', async () => {
    const places = [
      near('A', { state: 'not_published', value: 77, reason: 'not_published_by_aihw' }),
    ];
    const answer = await compareHospitals(world(places), ask);
    expect(answer.not_ranked[0]?.median_wait).toMatchObject({
      status: 'not_published',
      value: null,
    });
    expect(JSON.stringify(answer.not_ranked[0]?.median_wait)).not.toContain('77');
  });
});

describe('surgerywaits_explain_urgency', () => {
  it('explains each category by number or by word', async () => {
    for (const category of CATEGORIES) {
      for (const name of [
        String(category.number),
        category.word,
        `Category ${String(category.number)}`,
      ]) {
        const answer = await explainUrgency(read, { category: name });
        expect(answer).toMatchObject({
          category: category.number,
          recommended_within: category.within,
        });
        expect(answer.hospitals_listed).toBeGreaterThan(0);
      }
    }
    await expect(explainUrgency(read, { category: '4' })).rejects.toThrow(
      /not an urgency category/u,
    );
  });

  it('uses the wording the site gives each category', async () => {
    const yaml = readFileSync(
      new URL('../../content/templates/urgency.yaml', import.meta.url),
      'utf8',
    );
    const within = [...yaml.matchAll(/^ {4}within: (.+)$/gmu)].map((m) => m[1]);
    const meaning = [...yaml.matchAll(/^ {4}meaning: (.+)$/gmu)].map((m) => m[1]);
    expect(CATEGORIES.map((c) => c.within)).toEqual(within);
    expect(CATEGORIES.map((c) => c.meaning)).toEqual(meaning);
    const short = [...yaml.matchAll(/^ {2}- short: (.+)$/gmu)].map((m) => m[1]);
    expect(CATEGORIES.map((c) => c.word)).toEqual(short);
    const note = /^specialist_note: (.+)$/mu.exec(yaml)?.[1];
    expect(note).toBeDefined();
    for (const category of CATEGORIES) {
      const answer = await explainUrgency(read, { category: String(category.number) });
      expect(answer.who_decides.startsWith(note ?? '')).toBe(true);
    }
  });
});

describe('what the tools read', () => {
  it('asks only for data files of this site', () => {
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) {
      expect(url).toMatch(/^https:\/\/surgerywaits\.au\/data-api\/[a-z0-9/-]+\.json$/u);
    }
  });
});

describe('argument checks', () => {
  const spec = SPECS['surgerywaits_compare_hospitals'] ?? { properties: {}, required: [] };
  it('refuses an argument that is missing, unknown, mistyped or out of range', () => {
    const cases: [unknown, RegExp][] = [
      [{ procedure: 'a', locality: 'Armidale' }, /procedure/u],
      [{ procedure: 'cataract' }, /missing argument locality/u],
      [{ procedure: 'cataract', locality: 'Armidale', extra: 1 }, /unknown argument/u],
      [{ procedure: 'cataract', locality: 'Armidale', radius_km: 251 }, /radius_km/u],
      [{ procedure: 'cataract', locality: 'Armidale', radius_km: '5' }, /radius_km/u],
      [{ procedure: 'cataract', locality: 'Armidale', limit: 1.5 }, /limit/u],
      [{ procedure: 'cataract', locality: 'Armidale', limit: 0 }, /limit/u],
      [{ procedure: 7, locality: 'Armidale' }, /procedure/u],
      [['cataract'], /object/u],
      [null, /object/u],
    ];
    for (const [args, problem] of cases) {
      expect(argumentProblem(spec, args)).toMatch(problem);
    }
  });

  it('accepts a whole valid call and a name that only looks like a property of Object', () => {
    const valid = { procedure: 'cataract', locality: 'Armidale', radius_km: 5.5, limit: 3 };
    expect(argumentProblem(spec, valid)).toBeUndefined();
    expect(argumentProblem(spec, { ...valid, constructor: 1 })).toMatch(/unknown/u);
  });
});
