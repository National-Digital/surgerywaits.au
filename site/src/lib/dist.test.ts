import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIST_ENV,
  DistError,
  distDirectory,
  listDist,
  readDist,
  readHealthService,
  readHealthServiceIndex,
  readHospital,
  schemaFor,
  validateDist,
} from './dist';

const real = distDirectory();
const copies: string[] = [];

// A copy of the fixture dist with one file changed, so the original is never touched.
function broken(path: string, change: (document: Record<string, unknown>) => void): string {
  const copy = mkdtempSync(join(tmpdir(), 'dist-'));
  copies.push(copy);
  cpSync(real, copy, { recursive: true });
  const file = join(copy, path);
  const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  change(document);
  writeFileSync(file, JSON.stringify(document));
  vi.stubEnv(DIST_ENV, copy);
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const copy of copies.splice(0)) {
    rmSync(copy, { recursive: true, force: true });
  }
});

describe('distDirectory', () => {
  it('names the directory the variable sets', () => {
    expect(distDirectory()).toBe(real);
  });

  it('fails when the variable is missing or not absolute', () => {
    vi.stubEnv(DIST_ENV, '');
    expect(() => distDirectory()).toThrow(DistError);
    vi.stubEnv(DIST_ENV, 'pipeline/dist');
    expect(() => distDirectory()).toThrow(/absolute/);
  });
});

describe('schemaFor', () => {
  it.each([
    ['index.json', 'index'],
    ['hospitals.json', 'hospital-index'],
    ['hospitals/armidale-hospital.json', 'hospital'],
    ['trends/armidale-hospital.json', 'trend'],
    ['surgeries/procedure/adenoidectomy.json', 'surgery'],
    ['states/nsw.json', 'state'],
    ['health-services.json', 'health-service-index'],
    ['health-services/hunter-new-england.json', 'health-service'],
    ['queensland/h0385.json', 'queensland'],
  ])('maps %s to the %s schema', (path, schema) => {
    expect(schemaFor(path)).toBe(schema);
  });

  it('refuses a file the contract does not describe', () => {
    expect(() => schemaFor('notes.json')).toThrow(DistError);
    expect(() => schemaFor('hospitals/a/b.json')).toThrow(DistError);
    expect(() => schemaFor('surgeries/adenoidectomy.json')).toThrow(DistError);
  });
});

describe('readDist', () => {
  it('validates every file in the fixture dist against its schema', () => {
    const paths = validateDist();
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toContain('hospitals/armidale-hospital.json');
  });

  it('reads a hospital with its surgeries and figures', () => {
    const hospital = readHospital('armidale-hospital');
    expect(hospital.name).toBe('Armidale Hospital');
    expect(hospital.surgeries.length).toBeGreaterThan(0);
  });

  it('lists hospitals in a fixed order', () => {
    const slugs = listDist('hospitals');
    expect(slugs).toEqual([...slugs].sort());
    expect(slugs).toContain('armidale-hospital');
  });

  it('reads each network with member hospitals that exist as hospital files', () => {
    const rows = readHealthServiceIndex();
    expect(rows.length).toBeGreaterThan(0);
    const slugs = new Set(listDist('hospitals'));
    for (const row of rows) {
      const network = readHealthService(row.slug);
      expect(network.hospitals).toHaveLength(row.hospitals);
      for (const member of network.hospitals) {
        expect(slugs.has(member.slug)).toBe(true);
        expect(readHospital(member.slug).network?.slug).toBe(row.slug);
      }
    }
    expect(listDist('health-services')).toEqual(rows.map((r) => r.slug).sort());
  });

  it('rejects a network file that lost its slug', () => {
    const path = broken('health-services/hunter-new-england.json', (doc) => {
      Reflect.deleteProperty(doc, 'slug');
    });
    expect(() => readDist(path)).toThrow(/health-service schema/);
  });

  it('rejects a published figure that lost its release date', () => {
    const path = broken('hospitals/armidale-hospital.json', (doc) => {
      const surgery = (
        doc['surgeries'] as { measures: Record<string, { figure: Record<string, unknown> }> }[]
      )[0];
      const figure = Object.values(surgery?.measures ?? {})[0]?.figure ?? {};
      Reflect.deleteProperty(figure, 'release');
    });
    expect(() => readDist(path)).toThrow(/hospital schema/);
  });

  it('reports every error in a file, not only the first', () => {
    const path = broken('hospitals/armidale-hospital.json', (doc) => {
      Reflect.deleteProperty(doc, 'name');
      Reflect.deleteProperty(doc, 'slug');
    });
    let message = '';
    try {
      readDist(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/name/);
    expect(message).toMatch(/slug/);
  });

  it('rejects a withheld figure that carries a number', () => {
    const path = broken('hospitals/armidale-hospital.json', (doc) => {
      const surgeries = doc['surgeries'] as {
        measures: Record<string, { figure: Record<string, unknown> }>;
      }[];
      const figure = surgeries
        .flatMap((s) => Object.values(s.measures))
        .map((m) => m.figure)
        .find((f) => f['state'] === 'not_published');
      if (figure) {
        figure['value'] = 0;
      }
    });
    expect(() => readDist(path)).toThrow(DistError);
  });

  it('rejects a reason the contract does not list', () => {
    broken('hospitals/armidale-hospital.json', (doc) => {
      const surgeries = doc['surgeries'] as {
        measures: Record<string, { figure: Record<string, unknown> }>;
      }[];
      const figure = surgeries
        .flatMap((s) => Object.values(s.measures))
        .map((m) => m.figure)
        .find((f) => f['state'] === 'not_published');
      if (figure) {
        figure['reason'] = 'unknown_marker';
      }
    });
    expect(() => validateDist()).toThrow(DistError);
  });
});
