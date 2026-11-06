import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Figure, QueenslandColumn, QueenslandFigure, Role } from './format';

export const DIST_ENV = 'SURGERYWAITS_DIST';

// Bundled with the code, so the schemas are found whichever directory the build runs from.
const schemaFiles = import.meta.glob<Record<string, unknown>>('../../../contract/*.schema.json', {
  eager: true,
  import: 'default',
});

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const schema of Object.values(schemaFiles)) {
  ajv.addSchema(schema);
}

export type SchemaName =
  | 'credits'
  | 'hospital'
  | 'hospital-index'
  | 'index'
  | 'queensland'
  | 'queensland-index'
  | 'state'
  | 'suburbs'
  | 'surgery'
  | 'surgery-index'
  | 'trend';

const ROOT_FILES: Record<string, SchemaName> = {
  'credits.json': 'credits',
  'hospitals.json': 'hospital-index',
  'index.json': 'index',
  'queensland.json': 'queensland-index',
  'suburbs.json': 'suburbs',
  'surgeries.json': 'surgery-index',
};

const FOLDERS: Record<string, SchemaName> = {
  hospitals: 'hospital',
  queensland: 'queensland',
  states: 'state',
  surgeries: 'surgery',
  trends: 'trend',
};

export class DistError extends Error {}

export function distDirectory(): string {
  const dir = process.env[DIST_ENV];
  if (dir === undefined || dir === '') {
    throw new DistError(`${DIST_ENV} must name the directory the pipeline wrote its dist to`);
  }
  if (!isAbsolute(dir)) {
    throw new DistError(`${DIST_ENV} must be an absolute path`);
  }
  return dir;
}

// The folder decides the schema, so a file nobody planned for fails instead of passing unchecked.
export function schemaFor(path: string): SchemaName {
  const root = ROOT_FILES[path];
  if (root !== undefined) {
    return root;
  }
  const [folder, ...rest] = path.split('/');
  const known = folder === undefined ? undefined : FOLDERS[folder];
  const depth = folder === 'surgeries' ? 2 : 1;
  if (known === undefined || rest.length !== depth || !path.endsWith('.json')) {
    throw new DistError(`${path} is not a file the contract describes`);
  }
  return known;
}

export function validateDocument(name: SchemaName, document: unknown, path: string = name): void {
  const validate = ajv.getSchema(`https://surgerywaits.au/contract/${name}.schema.json`);
  if (validate === undefined) {
    throw new DistError(`no schema named ${name} in contract/`);
  }
  if (validate(document) !== true) {
    const problems = (validate.errors ?? []).map(
      (e) => `${e.instancePath === '' ? '(root)' : e.instancePath}: ${e.message ?? ''}`,
    );
    throw new DistError(`${path} breaks the ${name} schema at ${problems.join('; ')}`);
  }
}

export function readDist(path: string): unknown {
  const name = schemaFor(path);
  const document: unknown = JSON.parse(readFileSync(join(distDirectory(), path), 'utf8'));
  validateDocument(name, document, path);
  return document;
}

interface Measure {
  figure: Figure;
  rank: { status: 'ranked'; position: number; of: number } | { status: 'unranked'; why: string };
}

export interface HospitalSurgery {
  kind: 'urgency' | 'procedure' | 'specialty';
  slug: string;
  name: string;
  stale: boolean;
  measures: Partial<Record<Role, Measure>>;
}

export interface Hospital {
  code: string;
  slug: string;
  name: string;
  closed: boolean;
  surgeries: HospitalSurgery[];
}

export interface QueenslandFacility {
  code: string;
  name: string;
  quarters: {
    period: string;
    release: string;
    total: Record<QueenslandColumn, QueenslandFigure>;
  }[];
}

// The cast is safe because readDist has just proved the document against its schema.
export function readHospital(slug: string): Hospital {
  return readDist(`hospitals/${slug}.json`) as Hospital;
}

export function readQueenslandFacility(code: string): QueenslandFacility {
  return readDist(`queensland/${code}.json`) as QueenslandFacility;
}

export function listDist(folder: 'hospitals' | 'queensland'): string[] {
  return readdirSync(join(distDirectory(), folder))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

// Proves every JSON file under the dist against its schema; the checksums file is not JSON.
export function validateDist(): string[] {
  const root = distDirectory();
  const paths = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((p) => p.split('\\').join('/'))
    .filter((p) => p.endsWith('.json'))
    .sort();
  for (const path of paths) {
    readDist(path);
  }
  return paths;
}
