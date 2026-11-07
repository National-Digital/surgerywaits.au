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

  it('uses the wording the site gives each category', () => {
    const yaml = readFileSync(
      new URL('../../content/templates/urgency.yaml', import.meta.url),
      'utf8',
    );
    const within = [...yaml.matchAll(/^ {4}within: (.+)$/gmu)].map((m) => m[1]);
    const meaning = [...yaml.matchAll(/^ {4}meaning: (.+)$/gmu)].map((m) => m[1]);
    expect(CATEGORIES.map((c) => c.within)).toEqual(within);
    expect(CATEGORIES.map((c) => c.meaning)).toEqual(meaning);
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
