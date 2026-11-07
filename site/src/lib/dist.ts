import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Figure, QueenslandColumn, QueenslandFigure, Role, TrendPoint } from './format';

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
  | 'health-service'
  | 'health-service-index'
  | 'hospital'
  | 'hospital-index'
  | 'index'
  | 'queensland'
  | 'queensland-index'
  | 'rules'
  | 'state'
  | 'suburbs'
  | 'surgery'
  | 'surgery-index'
  | 'trend';

const ROOT_FILES: Record<string, SchemaName> = {
  'credits.json': 'credits',
  'health-services.json': 'health-service-index',
  'hospitals.json': 'hospital-index',
  'index.json': 'index',
  'queensland.json': 'queensland-index',
  'rules.json': 'rules',
  'suburbs.json': 'suburbs',
  'surgeries.json': 'surgery-index',
};

const FOLDERS: Record<string, SchemaName> = {
  'health-services': 'health-service',
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

export interface Measure {
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

type State = 'NSW' | 'Vic' | 'Qld' | 'WA' | 'SA' | 'Tas' | 'ACT' | 'NT' | 'OT';

interface NearbyHospital {
  code: string;
  name: string;
  slug: string | null;
  distance_km: number;
}

export interface Hospital {
  code: string;
  slug: string;
  name: string;
  alternative_names: string[];
  state: State;
  closed: boolean;
  scope: { sector: 'public'; private_excluded: string[] };
  network: { code: string; name: string; slug: string } | null;
  // Null where the source gave no coordinates, so there is no nearby list either.
  nearby: { radius_km: number; hospitals: NearbyHospital[] } | null;
  surgeries: HospitalSurgery[];
  sources: string[];
}

export interface HospitalIndexRow {
  code: string;
  slug: string;
  name: string;
  state: State;
  closed: boolean;
  network: { code: string; name: string; slug: string } | null;
  latitude: number | null;
  longitude: number | null;
  latest_period: string;
}

interface KindCount {
  count: number;
  period: string;
  release: string;
}

interface HealthServiceMember {
  code: string;
  slug: string;
  name: string;
  state: State;
  closed: boolean;
  // Categories of each kind the hospital reported in the newest period of that kind's table.
  surgeries: Record<'urgency' | 'procedures' | 'specialties', KindCount>;
  urgent_on_time: {
    status: 'published' | 'not_published' | 'not_reported' | 'stale' | 'missing';
    figure: Figure | null;
    // Null only when the status is missing.
    period: string | null;
    release: string | null;
  };
}

export interface HealthService {
  code: string;
  slug: string;
  name: string;
  display_name: string;
  states: State[];
  scope: Hospital['scope'];
  hospitals: HealthServiceMember[];
  sources: string[];
}

export interface HealthServiceIndexRow {
  code: string;
  slug: string;
  name: string;
  display_name: string;
  states: State[];
  hospitals: number;
}

export type Kind = HospitalSurgery['kind'];

export interface SurgeryRow {
  code: string;
  slug: string;
  name: string;
  state: State;
  closed: boolean;
  measures: Partial<Record<Role, Measure>>;
}

export type Benchmark = Partial<Record<Role, Figure>>;

export interface BenchmarkSeries {
  scope: string;
  role: Role;
  release: string;
  periods: string[];
  points: TrendPoint[];
}

export interface Surgery {
  kind: Kind;
  slug: string;
  name: string;
  code: string;
  period: string;
  release: string;
  scope: { sector: 'public'; private_excluded: string[] };
  hospitals: SurgeryRow[];
  benchmarks: {
    national: Benchmark | null;
    states: { state: Exclude<State, 'OT'>; measures: Benchmark }[];
    trends: BenchmarkSeries[];
  };
  sources: string[];
}

export interface SurgeryIndexRow {
  kind: Kind;
  slug: string;
  name: string;
  code: string;
  hospitals: number;
  newest_period: string;
}

interface TrendSeries {
  kind: HospitalSurgery['kind'];
  slug: string;
  role: Role;
  release: string;
  periods: string[];
  points: TrendPoint[];
}

export interface StateSurgery {
  kind: Kind;
  slug: string;
  name: string;
  period: string;
  release: string;
  measures: Benchmark;
  national: Benchmark | null;
}

export interface StateBenchmarks {
  state: Exclude<State, 'OT'>;
  slug: string;
  name: string;
  scope: { sector: 'public'; private_excluded: string[] };
  surgeries: StateSurgery[];
  sources: string[];
}

export interface Trend {
  series: TrendSeries[];
  sources: string[];
}

export interface QueenslandFacility {
  code: string;
  name: string;
  sources: string[];
  quarters: {
    period: string;
    period_end: string;
    release: string;
    total: Record<QueenslandColumn, QueenslandFigure>;
  }[];
}

export interface QueenslandIndex {
  facilities: {
    facility_code: string;
    facility_name: string;
    hospital_code: string;
    matched_by: 'name' | 'override';
    slug: string | null;
  }[];
  quarters: { period: string; period_end: string }[];
  sources: string[];
}

// The cast is safe because readDist has just proved the document against its schema.
export function readHospital(slug: string): Hospital {
  return readDist(`hospitals/${slug}.json`) as Hospital;
}

export function readHospitalIndex(): HospitalIndexRow[] {
  return (readDist('hospitals.json') as { hospitals: HospitalIndexRow[] }).hospitals;
}

export function readHospitalSources(): string[] {
  return (readDist('hospitals.json') as { sources: string[] }).sources;
}

export function readHealthService(slug: string): HealthService {
  return readDist(`health-services/${slug}.json`) as HealthService;
}

export function readHealthServiceIndex(): HealthServiceIndexRow[] {
  return (readDist('health-services.json') as { networks: HealthServiceIndexRow[] }).networks;
}

export function readHealthServiceIndexSources(): string[] {
  return (readDist('health-services.json') as { sources: string[] }).sources;
}

export function readTrend(slug: string): Trend {
  return readDist(`trends/${slug}.json`) as Trend;
}

export function readQueenslandIndex(): QueenslandIndex {
  return readDist('queensland.json') as QueenslandIndex;
}

export function readQueenslandFacility(code: string): QueenslandFacility {
  return readDist(`queensland/${code}.json`) as QueenslandFacility;
}

export function readState(slug: string): StateBenchmarks {
  return readDist(`states/${slug}.json`) as StateBenchmarks;
}

export function readSurgery(kind: Kind, slug: string): Surgery {
  return readDist(`surgeries/${kind}/${slug}.json`) as Surgery;
}

export interface Rules {
  neighbours: number;
  start_radius_km: number;
  max_period_age_years: number;
  max_qld_lag_days: number;
  long_wait_days: number;
  hand_matched_facilities: number;
  measures: Record<Role, string>;
  // AIHW's code for a withheld figure, with the reason the pipeline gives it.
  withheld_codes: Record<string, string>;
  lower_is_better: Record<Role, boolean | null>;
}

export function readRules(): Rules {
  return readDist('rules.json') as Rules;
}

export const longWaitDays = (): string => String(readRules().long_wait_days);

export function readSuburbs(): [string, string, State, number, number][] {
  return (readDist('suburbs.json') as { suburbs: [string, string, State, number, number][] })
    .suburbs;
}

export function readSurgeryIndex(): SurgeryIndexRow[] {
  return (readDist('surgeries.json') as { surgeries: SurgeryIndexRow[] }).surgeries;
}

export function readSurgeryIndexSources(): string[] {
  return (readDist('surgeries.json') as { sources: string[] }).sources;
}

// Each kind has its own folder, so one slug may appear under two kinds.
export function listSurgeries(kind: Kind): string[] {
  return readdirSync(join(distDirectory(), 'surgeries', kind))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

export function listDist(
  folder: 'health-services' | 'hospitals' | 'queensland' | 'states' | 'trends',
): string[] {
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
