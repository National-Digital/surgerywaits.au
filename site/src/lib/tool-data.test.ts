import { describe, expect, it } from 'vitest';
import { getSynonyms } from './content';
import { pairRoutes } from './pair-page';
import { readSurgeryIndex, validateDocument } from './dist';
import {
  buildToolIndex,
  buildToolPlaces,
  buildToolProcedure,
  procedureSlugs,
  stableJson,
  toolIndexJson,
  toolPlacesJson,
  toolFiguresJson,
  unknownSynonyms,
} from './tool-data';

const index = buildToolIndex();
const WITHHELD = /^[a-z_]+$/;
const files = procedureSlugs().map((slug) => buildToolProcedure(slug));

describe('the compare tool data', () => {
  it('validates each file against its schema and writes the same bytes twice', () => {
    validateDocument('tool-index', JSON.parse(toolIndexJson()));
    validateDocument('tool-places', JSON.parse(toolPlacesJson()));
    validateDocument('tool-figures', JSON.parse(toolFiguresJson()));
    expect(toolIndexJson()).toBe(toolIndexJson());
    expect(toolFiguresJson()).toBe(toolFiguresJson());
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

  it('keeps the index free of figures and places, and gives every procedure a row set in one figures file', () => {
    expect(Object.keys(index).sort()).toEqual([
      'hospitals',
      'neighbours',
      'procedures',
      'reasons',
      'strings',
    ]);
    expect(index.procedures.map((p) => p.slug).sort()).toEqual([...procedureSlugs()].sort());
    expect(buildToolPlaces().places.length).toBeGreaterThan(0);
    const figures = JSON.parse(toolFiguresJson()) as { procedures: Record<string, unknown> };
    expect(Object.keys(figures.procedures).sort()).toEqual([...procedureSlugs()].sort());
  });

  it('lists only open hospitals with a location, and every figure row points at one', () => {
    expect(index.hospitals.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const row of file.rows) {
        expect(index.hospitals[row[0]]).toBeDefined();
        expect(file.stamps[row[1]]).toBeDefined();
      }
      for (const hospital of file.pairs) {
        expect(file.rows.some((row) => row[0] === hospital)).toBe(true);
      }
    }
  });

  it('carries a withheld figure as a reason code and never as a number, and ranks only a published one', () => {
    let withheld = 0;
    for (const file of files) {
      for (const [, , median, volume, rank, history] of file.rows) {
        if (median < 0) {
          withheld += 1;
          expect(index.reasons[-median - 1]).toMatch(WITHHELD);
          expect(rank).toBeNull();
        }
        if (volume < 0) {
          expect(index.reasons[-volume - 1]).toMatch(WITHHELD);
        }
        if (history !== null) {
          expect(history.slice(1).some((v) => v !== null && v >= 0)).toBe(true);
        }
      }
    }
    expect(withheld).toBeGreaterThan(0);
  });

  it('takes its strings from the compare template, and a place from the suburbs file', () => {
    expect(index.strings.submit).toBe('Compare near you');
    expect(index.neighbours).toBe(8);
  });

  it('lists as having a pair page exactly the hospitals whose page is built', () => {
    const built = new Set(pairRoutes().map(({ params }) => `${params.slug}/${params.surgery}`));
    let listed = 0;
    for (const file of files) {
      const surgery = index.procedures.find((p) => p.slug === file.slug)?.surgery ?? '';
      for (const row of file.rows) {
        const slug = index.hospitals[row[0]]?.[0] ?? '';
        expect(file.pairs.includes(row[0]), `${slug}/${surgery}`).toBe(
          built.has(`${slug}/${surgery}`),
        );
      }
      listed += file.pairs.length;
    }
    expect(listed).toBeGreaterThan(0);
  });

  it('gives each procedure its address and the synonyms the content lists', () => {
    const knee = index.procedures.find((p) => p.slug === 'total-knee-replacement');
    expect(knee?.path).toBe('/surgery/knee-replacement/');
    expect(knee?.surgery).toBe('knee-replacement');
    expect(knee?.name).toBe('Knee replacement');
    expect(knee?.terms).toEqual(['Total knee replacement']);
    const cataract = index.procedures.find((p) => p.name === 'Cataract surgery');
    expect(cataract?.terms).toContain('cataracts');
  });
});
