import {
  distDirectory,
  readHospital,
  readHospitalIndex,
  readSuburbs,
  readSurgery,
  readTrend,
} from './dist';
import type { Benchmark, Hospital, HospitalIndexRow, Surgery, SurgeryRow, Trend } from './dist';
import { listDist } from './dist';
import { isPublished } from './format';
import type { Figure, PublishedFigure, Role } from './format';
import { distanceKm } from './geo';
import type { Position } from './geo';
import { hospitalPath, rankOf, TABLE_ROLES } from './hospital-page';
import { benchmarkCells, isCurrent, NATIONAL, surgeryRefs } from './surgery-page';
import type { TableRow } from './table';
import type { SurgeryRef } from './surgery-page';
import type { ChartSeries } from './chart';
import type { Tile } from './hospital-page';

export interface PairRoute {
  slug: string;
  surgery: string;
}

export const pairPath = (hospital: string, surgery: Pick<SurgeryRef, 'urlSlug'>): string =>
  `${hospitalPath(hospital)}${surgery.urlSlug}/`;

interface Context {
  surgeries: Map<string, Surgery>;
  hospitals: Map<string, Hospital>;
  trends: Map<string, Trend>;
  index: Map<string, HospitalIndexRow>;
  suburbs: Map<string, { name: string; position: Position }[]>;
}

let cached: { key: string; context: Context } | undefined;

// Each file is read and proved once, because every pair page draws on three of them.
function context(): Context {
  const key = distDirectory();
  if (cached?.key === key) {
    return cached.context;
  }
  const trendSlugs = new Set(listDist('trends'));
  const hospitals = new Map<string, Hospital>();
  const trends = new Map<string, Trend>();
  const index = new Map<string, HospitalIndexRow>();
  for (const row of readHospitalIndex()) {
    index.set(row.slug, row);
    hospitals.set(row.slug, readHospital(row.slug));
    if (trendSlugs.has(row.slug)) {
      trends.set(row.slug, readTrend(row.slug));
    }
  }
  const surgeries = new Map(
    surgeryRefs()
      .filter((ref) => ref.kind === 'procedure')
      .map((ref) => [ref.urlSlug, readSurgery(ref.kind, ref.slug)]),
  );
  const suburbs = new Map<string, { name: string; position: Position }[]>();
  for (const [, name, state, latitude, longitude] of readSuburbs()) {
    suburbs.set(state, [
      ...(suburbs.get(state) ?? []),
      { name, position: { latitude, longitude } },
    ]);
  }
  const context = { surgeries, hospitals, trends, index, suburbs };
  cached = { key, context };
  return context;
}

export interface PairData {
  hospital: Hospital;
  ref: SurgeryRef;
  surgery: Surgery;
  row: SurgeryRow;
  trend: Trend | undefined;
  area: string | null;
  thin: boolean;
}

// The nearest place in the hospital's state by centre, named without its disambiguating bracket.
function areaOf(state: string, position: Position | undefined): string | null {
  const places = context().suburbs.get(state);
  if (position === undefined || places === undefined) {
    return null;
  }
  let best: { name: string; km: number } | undefined;
  for (const place of places) {
    const km = distanceKm(position, place.position);
    if (best === undefined || km < best.km) {
      best = { name: place.name, km };
    }
  }
  return best === undefined ? null : best.name.replace(/\s*\([^)]*\)$/u, '');
}

const medianOf = (row: SurgeryRow): number | null => {
  const figure = row.measures.median_wait?.figure;
  return figure?.state === 'published' ? figure.value : null;
};

// An earlier published median that differs in period from this one is a history to tell.
function hasHistory(trend: Trend | undefined, ref: SurgeryRef, period: string): boolean {
  const series = trend?.series.find(
    (s) => s.kind === 'procedure' && s.slug === ref.slug && s.role === 'median_wait',
  );
  return (
    series?.points.some((point, i) => point[1] !== null && series.periods[i] !== period) ?? false
  );
}

type Nearby = Hospital['nearby'];

// The hospital's own mesh of nearest open hospitals, each paired with its row in this surgery.
function meshRows(
  surgery: Surgery,
  row: SurgeryRow,
  nearby: Nearby,
): { distanceKm: number; name: string; row: SurgeryRow }[] {
  if (nearby === null || row.closed) {
    return [];
  }
  return nearby.hospitals.flatMap((near) => {
    const other = surgery.hospitals.find((h) => h.code === near.code);
    return other !== undefined &&
      other.code !== row.code &&
      !other.closed &&
      isCurrent(other, surgery) &&
      medianOf(other) !== null
      ? [{ distanceKm: near.distance_km, name: near.name, row: other }]
      : [];
  });
}

// Thin: no published median, or a median with no history, no published neighbour in the hospital's mesh, no long-wait share and no area to add.
export function isThin(
  surgery: Surgery,
  row: SurgeryRow,
  parts: {
    trend: Trend | undefined;
    ref: SurgeryRef;
    nearby: Nearby;
    area: string | null;
  },
): boolean {
  if (medianOf(row) === null) {
    return true;
  }
  const own = row.measures.long_wait?.figure;
  const national = surgery.benchmarks.national?.long_wait;
  const longWait =
    own !== undefined && isPublished(own) && national !== undefined && isPublished(national);
  return (
    !hasHistory(parts.trend, parts.ref, surgery.period) &&
    meshRows(surgery, row, parts.nearby).length === 0 &&
    !longWait &&
    parts.area === null
  );
}

const positionOf = (at: HospitalIndexRow | undefined): Position | undefined =>
  at === undefined || at.latitude === null || at.longitude === null
    ? undefined
    : { latitude: at.latitude, longitude: at.longitude };

const pairs = new Map<string, PairData[]>();

// Every current row of every procedure, since the earlier site built a page for each and no other.
function allPairs(): PairData[] {
  const key = distDirectory();
  const found = pairs.get(key);
  if (found !== undefined) {
    return found;
  }
  const { surgeries, hospitals, trends, index } = context();
  const built = surgeryRefs()
    .filter((ref) => ref.kind === 'procedure')
    .flatMap((ref) => {
      const surgery = surgeries.get(ref.urlSlug);
      if (surgery === undefined) {
        throw new RangeError(`no surgery for ${ref.urlSlug}`);
      }
      return surgery.hospitals
        .filter((row) => isCurrent(row, surgery))
        .map((row): PairData => {
          const hospital = hospitals.get(row.slug);
          const at = index.get(row.slug);
          if (hospital === undefined || at === undefined) {
            throw new RangeError(`${surgery.slug} lists ${row.slug}, which is not a hospital`);
          }
          const position = positionOf(at);
          const trend = trends.get(row.slug);
          const area = areaOf(hospital.state, position);
          return {
            hospital,
            ref,
            surgery,
            row,
            trend,
            area,
            thin: isThin(surgery, row, { trend, ref, nearby: hospital.nearby, area }),
          };
        });
    })
    .sort((a, b) => (pairPath(a.hospital.slug, a.ref) < pairPath(b.hospital.slug, b.ref) ? -1 : 1));
  pairs.set(key, built);
  return built;
}

export const pairRoutes = (): { params: { slug: string; surgery: string }; props: PairRoute }[] =>
  allPairs().map(({ hospital, ref }) => ({
    params: { slug: hospital.slug, surgery: ref.urlSlug },
    props: { slug: hospital.slug, surgery: ref.urlSlug },
  }));

export function loadPair(slug: string, surgery: string): PairData {
  const found = allPairs().find((p) => p.hospital.slug === slug && p.ref.urlSlug === surgery);
  if (found === undefined) {
    throw new RangeError(`no pair page for ${slug} and ${surgery}`);
  }
  return found;
}

// The names a chart plots, in a sentence, so two charts on one page never share a label.
export const listed = (series: readonly { name: string }[]): string =>
  new Intl.ListFormat('en-AU').format(series.map((s) => s.name));

export const hasMedian = (pair: PairData): boolean =>
  pair.row.measures.median_wait !== undefined && isPublished(pair.row.measures.median_wait.figure);

// The hospital's row, then its state's and Australia's, so the table reads from near to far.
export function compareRows(
  pair: PairData,
  names: { state: string; stateRow: string; nationalRow: string },
): TableRow[] {
  const { hospital, surgery, row } = pair;
  const benchmark = (measures: Benchmark | null): TableRow['cells'] =>
    benchmarkCells(surgery, measures).map(({ figure }) => ({ figure }));
  const own = surgery.benchmarks.states.find((s) => s.state === hospital.state);
  return [
    {
      code: hospital.code,
      name: hospital.name,
      cells: TABLE_ROLES.map((role) => {
        const figure = row.measures[role]?.figure;
        if (figure === undefined) {
          throw new RangeError(`${hospital.slug}: ${surgery.slug} has no ${role}`);
        }
        return { figure };
      }),
    },
    ...(own === undefined
      ? []
      : [{ code: hospital.state, name: names.stateRow, cells: benchmark(own.measures) }]),
    { code: NATIONAL, name: names.nationalRow, cells: benchmark(surgery.benchmarks.national) },
  ];
}

// The pairs a sitemap may list; a thin pair is published and linked but left out.
export const indexablePairPaths = (): string[] =>
  allPairs()
    .filter((p) => !p.thin)
    .map((p) => pairPath(p.hospital.slug, p.ref));

export const thinPairPaths = (): string[] =>
  allPairs()
    .filter((p) => p.thin)
    .map((p) => pairPath(p.hospital.slug, p.ref));

// The hospital's own figures for this surgery, one tile for each measure it reports.
export function pairTiles(pair: PairData): Tile[] {
  return TABLE_ROLES.flatMap((role): Tile[] => {
    const measure = pair.row.measures[role];
    if (measure === undefined) {
      return [];
    }
    const rank = rankOf(measure, false);
    return [
      {
        key: role,
        measure: role,
        category: pair.ref.name,
        figure: measure.figure,
        stale: false,
        ...(rank === undefined ? {} : { rank }),
        change: role === 'median_wait' ? changeOnYear(pair, measure.figure) : null,
      },
    ];
  });
}

function changeOnYear(pair: PairData, figure: Tile['figure']): number | null {
  const series = pair.trend?.series.find(
    (s) => s.kind === 'procedure' && s.slug === pair.ref.slug && s.role === 'median_wait',
  );
  const last = series?.points.at(-1);
  return figure.state === 'published' && last?.[1] === figure.value ? last[2] : null;
}

// The hospital, its state and Australia on one chart where they share periods, else on charts of their own.
export function pairCharts(
  pair: PairData,
  names: { national: string; state: string },
): { id: string; series: ChartSeries[] }[] {
  const role: Role = 'median_wait';
  const own = pair.trend?.series.find(
    (s) => s.kind === 'procedure' && s.slug === pair.ref.slug && s.role === role,
  );
  const wanted: { name: string; series: ChartSeries | undefined }[] = [
    {
      name: pair.hospital.name,
      series: own && { name: pair.hospital.name, ...pick(own) },
    },
    ...[
      { scope: pair.hospital.state, name: names.state },
      { scope: NATIONAL, name: names.national },
    ].map(({ scope, name }) => {
      const found = pair.surgery.benchmarks.trends.find(
        (s) => s.scope === scope && s.role === role,
      );
      return { name, series: found && { name, ...pick(found) } };
    }),
  ];
  const groups = new Map<string, ChartSeries[]>();
  for (const { series } of wanted) {
    if (series !== undefined) {
      const key = `${series.release}|${series.periods.join()}`;
      groups.set(key, [...(groups.get(key) ?? []), series]);
    }
  }
  return [...groups.values()].map((series, i) => ({
    id: `chart-median-wait-${String(i)}`,
    series,
  }));
}

const pick = (s: {
  release: string;
  periods: readonly string[];
  points: ChartSeries['points'];
}): Omit<ChartSeries, 'name'> => ({ release: s.release, periods: s.periods, points: s.points });

export interface Shorter {
  name: string;
  href: string;
  distanceKm: number;
  figure: Figure;
}

// The mesh hospitals that published a shorter median this period, nearest first.
export function shorterNearby(pair: PairData): Shorter[] | null {
  const own = medianOf(pair.row);
  if (own === null || pair.hospital.nearby === null) {
    return null;
  }
  return meshRows(pair.surgery, pair.row, pair.hospital.nearby).flatMap((near) => {
    const figure = near.row.measures.median_wait?.figure;
    return figure?.state === 'published' && figure.value < own
      ? [
          {
            name: near.name,
            href: pairPath(near.row.slug, pair.ref),
            distanceKm: near.distanceKm,
            figure,
          },
        ]
      : [];
  });
}

export interface History {
  direction: 'rose' | 'fell' | 'unchanged';
  from: PublishedFigure;
  to: PublishedFigure;
}

// The earliest published median that differs in period from this one, set against it.
export function history(pair: PairData): History | null {
  const to = pair.row.measures.median_wait?.figure;
  const series = pair.trend?.series.find(
    (s) => s.kind === 'procedure' && s.slug === pair.ref.slug && s.role === 'median_wait',
  );
  if (to?.state !== 'published' || series === undefined) {
    return null;
  }
  const i = series.points.findIndex((p, n) => p[1] !== null && series.periods[n] !== to.period);
  const point = series.points[i];
  const period = series.periods[i];
  if (point === undefined || point[1] === null || period === undefined) {
    return null;
  }
  const from: PublishedFigure = {
    state: 'published',
    value: point[1],
    period,
    release: series.release,
  };
  return {
    direction: to.value > from.value ? 'rose' : to.value < from.value ? 'fell' : 'unchanged',
    from,
    to,
  };
}
