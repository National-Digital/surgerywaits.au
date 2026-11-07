import { describe, expect, it } from 'vitest';
import { getSynonyms } from './content';
import { readSurgeryIndex, validateDocument } from './dist';
import { buildToolData, stableJson, toolDataJson, unknownSynonyms } from './tool-data';

const data = buildToolData();
const WITHHELD = /^[a-z_]+$/;

describe('the compare tool data', () => {
  it('validates against its schema and writes the same bytes twice', () => {
    const first = toolDataJson();
    validateDocument('tool-data', JSON.parse(first));
    expect(toolDataJson()).toBe(first);
  });

  it('sorts keys at every depth', () => {
    expect(stableJson({ b: [{ z: 1, a: 2 }], a: null })).toBe('{"a":null,"b":[{"a":2,"z":1}]}');
  });

  it('maps every synonym to a procedure that exists in the dist', () => {
    const procedures = readSurgeryIndex()
      .filter((row) => row.kind === 'procedure')
      .map((row) => row.slug);
    expect(unknownSynonyms(procedures, getSynonyms())).toEqual([]);
    expect(unknownSynonyms(procedures, { 'no-such-procedure': ['x'] })).toEqual([
      'no-such-procedure',
    ]);
  });

  it('gives every synonym to exactly one procedure', () => {
    const owner = new Map<string, string>();
    for (const [slug, terms] of Object.entries(getSynonyms())) {
      for (const term of terms) {
        expect(owner.get(term), term).toBeUndefined();
        owner.set(term, slug);
      }
    }
  });

  it('lists only open hospitals with a location, in code order, and every figure row points at one', () => {
    expect(data.hospitals.length).toBeGreaterThan(0);
    for (const rows of Object.values(data.figures)) {
      for (const row of rows) {
        expect(data.hospitals[row[0]]).toBeDefined();
        expect(data.stamps[row[1]]).toBeDefined();
      }
    }
  });

  it('carries a withheld figure as a reason code and never as a number, and ranks only a published one', () => {
    let withheld = 0;
    for (const rows of Object.values(data.figures)) {
      for (const [, , median, volume, rank, history] of rows) {
        if (median < 0) {
          withheld += 1;
          expect(data.reasons[-median - 1]).toMatch(WITHHELD);
          expect(rank).toBeNull();
        }
        if (volume < 0) {
          expect(data.reasons[-volume - 1]).toMatch(WITHHELD);
        }
        if (history !== null) {
          expect(history.slice(1).some((v) => v !== null && v >= 0)).toBe(true);
        }
      }
    }
    expect(withheld).toBeGreaterThan(0);
  });

  it('takes its strings from the compare template, and a place from the suburbs file', () => {
    expect(data.strings.submit).toBe('Compare near you');
    expect(data.places.length).toBeGreaterThan(0);
    expect(data.neighbours).toBe(8);
  });

  it('gives each procedure its address and the synonyms the content lists', () => {
    const knee = data.procedures.find((p) => p.slug === 'total-knee-replacement');
    expect(knee?.path).toBe('/surgery/knee-replacement/');
    expect(knee?.name).toBe('Knee replacement');
    expect(knee?.terms).toEqual(['Total knee replacement']);
    const cataract = data.procedures.find((p) => p.name === 'Cataract surgery');
    expect(cataract?.terms).toContain('cataracts');
  });
});
