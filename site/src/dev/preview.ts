import { listDist, readDist, readHospital, readQueenslandFacility } from '../lib/dist';
import type { HospitalSurgery } from '../lib/dist';
import { sortRows } from '../lib/table';
import type { TableRow } from '../lib/table';
import type {
  Figure,
  NotPublishedReason,
  QueenslandColumn,
  QueenslandFigure,
  Role,
} from '../lib/format';

const ROLES: readonly Role[] = ['median_wait', 'volume', 'long_wait', 'on_time'];

// Every reason the contract allows, so a state the fixture dist lacks is still shown.
const REASONS: readonly NotPublishedReason[] = [
  'too_few_patients',
  'no_patients_reported',
  'not_published_by_aihw',
  'no_peer_group_comparison',
  'not_given_by_queensland_health',
];

export interface FigureSample {
  hospital: string;
  role: Role;
  figure: Figure;
}

export interface TileSample extends FigureSample {
  stale: boolean;
  rank?: { position: number; of: number };
  change?: number | null;
}

export interface QueenslandSample {
  facility: string;
  column: QueenslandColumn;
  figure: QueenslandFigure;
}

interface Trend {
  series: {
    kind: string;
    slug: string;
    role: Role;
    points: [number, number | null, number | null][];
  }[];
}

function* measures(): Generator<
  FigureSample & { surgery: HospitalSurgery; position?: { position: number; of: number } }
> {
  for (const slug of listDist('hospitals')) {
    const hospital = readHospital(slug);
    for (const surgery of hospital.surgeries) {
      for (const role of ROLES) {
        const measure = surgery.measures[role];
        if (measure !== undefined) {
          yield {
            hospital: hospital.name,
            role,
            figure: measure.figure,
            surgery,
            ...(measure.rank.status === 'ranked' ? { position: measure.rank } : {}),
          };
        }
      }
    }
  }
}

function changeOf(
  hospital: string,
  sample: { surgery: HospitalSurgery; role: Role; figure: Figure },
): number | null {
  const slug = listDist('hospitals').find((s) => readHospital(s).name === hospital);
  if (slug === undefined || sample.figure.state !== 'published') {
    return null;
  }
  const trend = readDist(`trends/${slug}.json`) as Trend;
  const series = trend.series.find(
    (s) =>
      s.kind === sample.surgery.kind && s.slug === sample.surgery.slug && s.role === sample.role,
  );
  const last = series?.points.at(-1);
  return last?.[1] === sample.figure.value ? (last[2] ?? null) : null;
}

export function sampleFigures(): FigureSample[] {
  const all = [...measures()];
  const picks = [
    all.find((m) => m.figure.state === 'published' && m.figure.value > 0 && !m.surgery.stale),
    all.find((m) => m.figure.state === 'published' && m.figure.value === 0),
    ...REASONS.map((reason) =>
      all.find((m) => m.figure.state === 'not_published' && m.figure.reason === reason),
    ),
  ];
  return picks.flatMap((m) =>
    m ? [{ hospital: m.hospital, role: m.role, figure: m.figure }] : [],
  );
}

export function sampleTiles(): TileSample[] {
  const all = [...measures()];
  const current = all.find((m) => m.position !== undefined && !m.surgery.stale);
  const stale = all.find((m) => m.surgery.stale && m.figure.state === 'published');
  const withheld = all.find((m) => m.figure.state !== 'published' && !m.surgery.stale);
  const plain = all.find(
    (m) => m.figure.state === 'published' && m.position === undefined && !m.surgery.stale,
  );
  const tiles: TileSample[] = [];
  if (current?.position) {
    tiles.push({
      hospital: current.hospital,
      role: current.role,
      figure: current.figure,
      stale: false,
      rank: current.position,
      change: changeOf(current.hospital, current),
    });
  }
  for (const m of [plain, stale, withheld]) {
    if (m) {
      tiles.push({ hospital: m.hospital, role: m.role, figure: m.figure, stale: m.surgery.stale });
    }
  }
  return tiles;
}

// Reasons the fixture lacks are built with the first figure's period and release.
export function withheldFigures(stamp: { period: string; release: string }): Figure[] {
  return [
    ...REASONS.map((reason): Figure => ({ state: 'not_published', reason, ...stamp })),
    { state: 'not_reported', reason: 'not_reported_by_source', ...stamp },
  ];
}

const QUEENSLAND_COLUMNS: readonly QueenslandColumn[] = [
  'treated',
  'percent_treated_in_time',
  'percent_change_treated_on_prior_year',
];

export function sampleQueensland(): QueenslandSample[] {
  const samples: QueenslandSample[] = [];
  for (const code of listDist('queensland')) {
    const facility = readQueenslandFacility(code);
    const [quarter] = facility.quarters;
    if (quarter === undefined) {
      continue;
    }
    if (samples.length === 0) {
      for (const column of QUEENSLAND_COLUMNS) {
        samples.push({ facility: facility.name, column, figure: quarter.total[column] });
      }
    }
    for (const [column, figure] of Object.entries(quarter.total) as [
      QueenslandColumn,
      QueenslandFigure,
    ][]) {
      if (
        figure.state === 'not_published' &&
        !samples.some((s) => s.figure.state === 'not_published')
      ) {
        samples.push({ facility: facility.name, column, figure });
      }
    }
  }
  return samples;
}

const TABLE_ROLES: readonly Role[] = ['median_wait', 'on_time', 'volume'];

export interface SurgeryTable {
  key: string;
  roles: readonly Role[];
  rows: TableRow[];
}

// Every surgery that all hospitals in it report on each table measure, with ranks only where ranked.
export function surgeryTables(): SurgeryTable[] {
  const byKey = new Map<string, TableRow[]>();
  for (const slug of listDist('hospitals')) {
    const hospital = readHospital(slug);
    for (const surgery of hospital.surgeries) {
      const cells = TABLE_ROLES.map((role) => surgery.measures[role]);
      if (cells.every((m) => m !== undefined)) {
        const key = `${surgery.kind}/${surgery.slug}`;
        byKey.set(key, [
          ...(byKey.get(key) ?? []),
          {
            code: hospital.code,
            name: hospital.name,
            stale: surgery.stale,
            cells: cells.map((m) => ({
              figure: m.figure,
              ...(m.rank.status === 'ranked' ? { rank: m.rank } : {}),
            })),
          },
        ]);
      }
    }
  }
  return [...byKey.entries()].map(([key, rows]) => ({
    key,
    roles: TABLE_ROLES,
    rows: sortRows(rows, 0, 'median_wait'),
  }));
}

// The table with the most hospitals that shows a ranked row, a stale row and a withheld cell.
export function sampleTable(): SurgeryTable {
  const score = (rows: TableRow[]): number =>
    Number(rows.some((r) => r.stale === true)) +
    Number(rows.some((r) => r.cells.some((c) => c.figure.state !== 'published'))) +
    Number(rows.some((r) => r.cells.some((c) => c.rank !== undefined)));
  const [best] = surgeryTables().sort(
    (a, b) =>
      score(b.rows) - score(a.rows) || b.rows.length - a.rows.length || (a.key < b.key ? -1 : 1),
  );
  return best ?? { key: '', roles: TABLE_ROLES, rows: [] };
}

// The first fixture hospital stands in for a page that draws on several sources.
export function samplePage(): { name: string; sources: string[] } {
  const [slug] = listDist('hospitals');
  if (slug === undefined) {
    throw new Error('the dist holds no hospital to preview');
  }
  const hospital = readDist(`hospitals/${slug}.json`) as { name: string; sources: string[] };
  return { name: hospital.name, sources: hospital.sources };
}
