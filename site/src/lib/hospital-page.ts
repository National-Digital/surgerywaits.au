import {
  listDist,
  readHospital,
  readHospitalIndex,
  readQueenslandFacility,
  readTrend,
} from './dist';
import type { Hospital, HospitalSurgery, Measure, QueenslandFacility, Trend } from './dist';
import type { ChartSeries } from './chart';
import { isPublished } from './format';
import type { Figure, QueenslandColumn, QueenslandFigure, Role } from './format';
import { sortRows } from './table';
import type { Span, TableRow } from './table';

export const HOSPITALS_PATH = '/hospitals/';

export const hospitalPath = (slug: string): string => `/hospital/${slug}/`;

// The index and the hospital files must name the same hospitals, so no page is built from one alone.
export function hospitalSlugs(): string[] {
  const indexed = readHospitalIndex()
    .map((row) => row.slug)
    .sort();
  const files = listDist('hospitals');
  if (indexed.join('\n') !== files.join('\n')) {
    throw new RangeError('hospitals.json and the hospital files do not list the same hospitals');
  }
  return indexed;
}

export interface HospitalData {
  hospital: Hospital;
  trend: Trend;
  queensland: QueenslandFacility | null;
}

export function loadHospital(slug: string): HospitalData {
  const hospital = readHospital(slug);
  const facilities = new Set(listDist('queensland'));
  const code = hospital.code.toLowerCase();
  // A hospital with fewer than two periods has no trend file, so it has no charts.
  const trend = listDist('trends').includes(slug) ? readTrend(slug) : { series: [], sources: [] };
  return {
    hospital,
    trend,
    queensland: facilities.has(code) ? readQueenslandFacility(code) : null,
  };
}

// A rank belongs only to a current published figure, so any other cell drops it here.
export function rankOf(
  measure: Measure,
  stale: boolean,
): { position: number; of: number } | undefined {
  if (stale || !isPublished(measure.figure) || measure.rank.status !== 'ranked') {
    return undefined;
  }
  return { position: measure.rank.position, of: measure.rank.of };
}

// The figure's change on the year before, read from the trend when its last point is this figure.
function changeOf(
  trend: Trend,
  surgery: HospitalSurgery,
  role: Role,
  figure: Figure,
): number | null {
  if (figure.state !== 'published' || surgery.stale) {
    return null;
  }
  const series = trend.series.find(
    (s) => s.kind === surgery.kind && s.slug === surgery.slug && s.role === role,
  );
  const last = series?.points.at(-1);
  return last?.[1] === figure.value ? last[2] : null;
}

export interface Tile {
  key: string;
  measure: Role;
  category: string;
  figure: Figure;
  stale: boolean;
  rank?: { position: number; of: number };
  change: number | null;
}

const TILE_ROLES: readonly Role[] = ['median_wait', 'on_time'];

export function urgencyTiles(
  data: HospitalData,
  names: Record<string, string>,
  order: readonly string[],
): Tile[] {
  const urgency = data.hospital.surgeries.filter((s) => s.kind === 'urgency');
  for (const surgery of urgency) {
    if (names[surgery.slug] === undefined) {
      throw new RangeError(`no name in content for the urgency category ${surgery.slug}`);
    }
  }
  const tiles: Tile[] = [];
  for (const role of TILE_ROLES) {
    for (const slug of order) {
      const surgery = urgency.find((s) => s.slug === slug);
      const measure = surgery?.measures[role];
      if (surgery === undefined || measure === undefined) {
        continue;
      }
      const rank = rankOf(measure, surgery.stale);
      tiles.push({
        key: `${role}-${slug}`,
        measure: role,
        category: names[slug] ?? slug,
        figure: measure.figure,
        stale: surgery.stale,
        ...(rank === undefined ? {} : { rank }),
        change: changeOf(data.trend, surgery, role, measure.figure),
      });
    }
  }
  return tiles;
}

export const TABLE_ROLES: readonly Role[] = ['median_wait', 'long_wait', 'volume'];

export interface SurgeryTableModel {
  rows: TableRow[];
  span?: Span;
}

// One table holds one kind, so its current rows share a period and release.
export function surgeryTable(
  hospital: Hospital,
  kind: 'procedure' | 'specialty',
): SurgeryTableModel | null {
  const surgeries = hospital.surgeries.filter((s) => s.kind === kind);
  if (surgeries.length === 0) {
    return null;
  }
  const rows: TableRow[] = surgeries.map((surgery) => ({
    code: surgery.slug,
    name: surgery.name,
    stale: surgery.stale,
    cells: TABLE_ROLES.map((role) => {
      const measure = surgery.measures[role];
      if (measure === undefined) {
        throw new RangeError(`${hospital.slug}: ${surgery.slug} has no ${role}`);
      }
      const rank = rankOf(measure, surgery.stale);
      return { figure: measure.figure, ...(rank === undefined ? {} : { rank }) };
    }),
  }));
  return sortedWithSpan(rows);
}

// With no current row, the table states the range of the earlier periods it holds.
export function sortedWithSpan(rows: TableRow[], role: Role = 'median_wait'): SurgeryTableModel {
  const sorted = sortRows(rows, 0, role);
  if (rows.some((row) => row.stale !== true)) {
    return { rows: sorted };
  }
  const figures = rows.flatMap((row) => row.cells.map((cell) => cell.figure));
  const periods = figures.map((f) => f.period).sort();
  const release = figures.map((f) => f.release).sort();
  return {
    rows: sorted,
    span: {
      first: periods[0] ?? '',
      last: periods.at(-1) ?? '',
      release: release.at(-1) ?? '',
    },
  };
}

// The newest period any figure on the page carries, which the description names.
export function latestPeriod(hospital: Hospital): string {
  const periods = hospital.surgeries
    .filter((s) => !s.stale)
    .flatMap((s) => Object.values(s.measures).map((m) => m.figure.period));
  const all = hospital.surgeries.flatMap((s) =>
    Object.values(s.measures).map((m) => m.figure.period),
  );
  return (periods.length > 0 ? periods : all).sort().at(-1) ?? '';
}

export const hasCurrentFigures = (hospital: Hospital): boolean =>
  hospital.surgeries.some((s) => !s.stale);

export const procedureTable = (hospital: Hospital): SurgeryTableModel | null =>
  surgeryTable(hospital, 'procedure');

export const specialtyTable = (hospital: Hospital): SurgeryTableModel | null =>
  surgeryTable(hospital, 'specialty');

export interface Chart {
  id: string;
  role: Role;
  series: ChartSeries[];
}

// Series that share a release and periods can share a chart; any other gets its own.
export function trendCharts(
  trend: Trend,
  names: Record<string, string>,
  order: readonly string[],
): Chart[] {
  const roles: Role[] = ['median_wait', 'on_time'];
  return roles.flatMap((role) => {
    const groups = new Map<string, ChartSeries[]>();
    for (const slug of order) {
      const series = trend.series.find(
        (s) => s.kind === 'urgency' && s.slug === slug && s.role === role,
      );
      if (series === undefined) {
        continue;
      }
      const key = `${series.release}|${series.periods.join()}`;
      groups.set(key, [
        ...(groups.get(key) ?? []),
        {
          name: names[slug] ?? slug,
          release: series.release,
          periods: series.periods,
          points: series.points,
        },
      ]);
    }
    return [...groups.values()].map((series, i) => ({
      id: `chart-${role.replace('_', '-')}-${String(i)}`,
      role,
      series,
    }));
  });
}

export function queenslandTiles(
  quarter: NonNullable<ReturnType<typeof newestQuarter>>,
  headings: { treated: string; timely: string; change: string },
): { heading: string; column: QueenslandColumn; figure: QueenslandFigure }[] {
  const { total } = quarter;
  return [
    { heading: headings.treated, column: 'treated', figure: total.treated },
    {
      heading: headings.timely,
      column: 'percent_treated_in_time',
      figure: total.percent_treated_in_time,
    },
    {
      heading: headings.change,
      column: 'percent_change_treated_on_prior_year',
      figure: total.percent_change_treated_on_prior_year,
    },
  ];
}

export function sourcesOf({ hospital, trend, queensland }: HospitalData): string[] {
  return [
    ...new Set([...hospital.sources, ...trend.sources, ...(queensland?.sources ?? [])]),
  ].sort();
}

export function newestQuarter(
  facility: QueenslandFacility,
): QueenslandFacility['quarters'][number] | undefined {
  return [...facility.quarters].sort((a, b) => (a.period_end < b.period_end ? 1 : -1))[0];
}
