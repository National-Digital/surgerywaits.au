import { getCompareTemplate, getSynonyms } from './content';
import {
  distDirectory,
  listDist,
  readDist,
  readHospitalIndex,
  readHospitalSources,
  readRules,
  readSuburbs,
  readSurgery,
  readSurgeryIndexSources,
  readTrend,
  validateDocument,
} from './dist';
import type { SchemaName } from './dist';
import type { Figure, TrendPoint } from './format';
import { pairRoutes } from './pair-page';
import { surgeryPath, surgeryRefs } from './surgery-page';
import type {
  FigureRow,
  HistoryRow,
  HospitalRow,
  PlaceRow,
  Procedure,
  ToolIndex,
  ToolPlaces,
  ToolProcedure,
  Value,
} from '../tool/data';

const PLACE_DECIMALS = 1000;
const HOSPITAL_DECIMALS = 10_000;

const before = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// A reason is written as -1 minus its place in this list, which keeps the file small.
const REASONS = [
  'no_patients_reported',
  'no_peer_group_comparison',
  'not_given_by_queensland_health',
  'not_published_by_aihw',
  'not_reported_by_source',
  'too_few_patients',
] as const;

const coded = (reason: string): number => {
  const at = REASONS.findIndex((r) => r === reason);
  if (at < 0) {
    throw new RangeError(`no code for the reason ${reason}`);
  }
  return -1 - at;
};

const value = (figure: Figure | undefined): Value =>
  figure === undefined || figure.state === 'not_reported'
    ? coded('not_reported_by_source')
    : figure.state === 'published'
      ? figure.value
      : coded(figure.reason);

// One run of years from the first point to the last, a null for a year the hospital skipped.
function runOf(points: readonly (readonly [number, Value])[]): HistoryRow | null {
  if (!points.some(([, v]) => v >= 0)) {
    return null;
  }
  const byYear = new Map(points);
  const first = Math.min(...byYear.keys());
  const last = Math.max(...byYear.keys());
  return [
    first,
    ...Array.from({ length: last - first + 1 }, (_, i) => byYear.get(first + i) ?? null),
  ];
}

// A withheld point carries its reason after the colon of its tag.
const pointValue = (point: TrendPoint): Value => point[1] ?? coded(point[3].split(':')[1] ?? '');

// A synonym that names no procedure in the dist is a typo, so it stops the build.
export function unknownSynonyms(
  known: Iterable<string>,
  listed: Record<string, unknown>,
): string[] {
  const slugs = new Set(known);
  return Object.keys(listed)
    .filter((slug) => !slugs.has(slug))
    .sort();
}

export const procedureSlugs = (): string[] =>
  surgeryRefs()
    .filter((ref) => ref.kind === 'procedure')
    .map((ref) => ref.slug);

// The hospitals the tool can place on a map, in code order; a row of a procedure file points into this list.
function locatedHospitals(): ReturnType<typeof readHospitalIndex> {
  return readHospitalIndex()
    .filter((h) => !h.closed && h.latitude !== null && h.longitude !== null)
    .sort((a, b) => before(a.code, b.code));
}

export function buildToolIndex(): ToolIndex {
  const refs = surgeryRefs().filter((ref) => ref.kind === 'procedure');
  const synonyms = getSynonyms();
  const unknown = unknownSynonyms(
    refs.map((ref) => ref.slug),
    synonyms,
  );
  if (unknown.length > 0) {
    throw new RangeError(`synonyms name no procedure in the dist: ${unknown.join(', ')}`);
  }
  const hospitals = locatedHospitals().map((h): HospitalRow => [
    h.slug,
    h.name,
    h.state,
    Math.round((h.latitude ?? 0) * HOSPITAL_DECIMALS) / HOSPITAL_DECIMALS,
    Math.round((h.longitude ?? 0) * HOSPITAL_DECIMALS) / HOSPITAL_DECIMALS,
  ]);
  const procedures: Procedure[] = refs.map((ref) => {
    const surgery = readSurgery('procedure', ref.slug);
    let of = 0;
    for (const row of surgery.hospitals) {
      const rank = row.measures.median_wait?.rank;
      if (rank?.status === 'ranked') {
        if (of !== 0 && of !== rank.of) {
          throw new RangeError(`${ref.slug} has two rank sizes`);
        }
        of = rank.of;
      }
    }
    return {
      name: ref.name,
      of,
      path: surgeryPath(ref),
      period: surgery.period,
      slug: ref.slug,
      surgery: ref.urlSlug,
      terms: [
        ...new Set([
          ...(synonyms[ref.slug] ?? []),
          ...(ref.source === ref.name ? [] : [ref.source]),
        ]),
      ].sort(before),
    };
  });
  procedures.sort(
    (a, b) => before(a.name.toLowerCase(), b.name.toLowerCase()) || before(a.slug, b.slug),
  );
  return {
    hospitals,
    neighbours: readRules().neighbours,
    procedures,
    reasons: [...REASONS],
    strings: getCompareTemplate().tool,
  };
}

export function buildToolPlaces(): ToolPlaces {
  const places = [...readSuburbs()]
    .sort((a, b) => before(a[1], b[1]) || before(a[2], b[2]) || before(a[0], b[0]))
    .map(([, name, state, lat, lon]): PlaceRow => [
      name,
      state,
      Math.round(lat * PLACE_DECIMALS) / PLACE_DECIMALS,
      Math.round(lon * PLACE_DECIMALS) / PLACE_DECIMALS,
    ]);
  return { places };
}

let routes: { key: string; bySurgery: Map<string, Set<string>> } | undefined;

// The hospitals that have a built page for a surgery, read once from the pair routes.
function pairHospitals(surgery: string): Set<string> {
  const key = distDirectory();
  if (routes?.key !== key) {
    const bySurgery = new Map<string, Set<string>>();
    for (const { params } of pairRoutes()) {
      bySurgery.set(params.surgery, (bySurgery.get(params.surgery) ?? new Set()).add(params.slug));
    }
    routes = { key, bySurgery };
  }
  return routes.bySurgery.get(surgery) ?? new Set();
}

// One procedure's figure rows, each pointing at its hospital's place in the index.
export function buildToolProcedure(slug: string): ToolProcedure {
  const ref = surgeryRefs().find((r) => r.kind === 'procedure' && r.slug === slug);
  if (ref === undefined) {
    throw new RangeError(`no procedure ${slug}`);
  }
  const indexOf = new Map(locatedHospitals().map((h, i) => [h.slug, i]));
  const withTrend = new Set(listDist('trends'));
  const surgery = readSurgery('procedure', slug);
  const built = pairHospitals(ref.urlSlug);
  const stamps: [string, string][] = [];
  const stampOf = (figure: Figure): number => {
    const at = stamps.findIndex(([p, r]) => p === figure.period && r === figure.release);
    if (at >= 0) {
      return at;
    }
    stamps.push([figure.period, figure.release]);
    return stamps.length - 1;
  };
  const rows: FigureRow[] = [];
  const pairs: number[] = [];
  for (const row of surgery.hospitals) {
    const index = indexOf.get(row.slug);
    const median = row.measures.median_wait;
    if (index === undefined || median === undefined) {
      continue;
    }
    const volume = row.measures.volume;
    if (
      volume !== undefined &&
      (volume.figure.period !== median.figure.period ||
        volume.figure.release !== median.figure.release)
    ) {
      throw new RangeError(`${row.slug} gives ${slug} two periods`);
    }
    // A hospital that reported one year only has no trend file.
    const series = withTrend.has(row.slug) ? readTrend(row.slug).series : [];
    const history = runOf(
      series
        .filter((s) => s.kind === 'procedure' && s.slug === slug && s.role === 'median_wait')
        .flatMap((s) => s.points.map((p) => [p[0], pointValue(p)] as const)),
    );
    rows.push([
      index,
      stampOf(median.figure),
      value(median.figure),
      value(volume?.figure),
      median.rank.status === 'ranked' ? median.rank.position : null,
      history,
    ]);
    if (built.has(row.slug)) {
      pairs.push(index);
    }
  }
  rows.sort((a, b) => a[0] - b[0]);
  return { pairs: pairs.sort((a, b) => a - b), rows, slug, stamps };
}

// Keys sorted at every depth, so two builds write the same bytes.
export function stableJson(node: unknown): string {
  if (Array.isArray(node)) {
    return `[${node.map(stableJson).join(',')}]`;
  }
  if (node !== null && typeof node === 'object') {
    return `{${Object.entries(node)
      .sort(([a], [b]) => before(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(node);
}

// Each file is checked against its own schema before it is served, as every dist file is.
function checked(name: SchemaName, node: unknown, path: string): string {
  const text = stableJson(node);
  validateDocument(name, JSON.parse(text), path);
  return text;
}

export const toolIndexJson = (): string =>
  checked('tool-index', buildToolIndex(), '/tool/index.json');
export const toolPlacesJson = (): string =>
  checked('tool-places', buildToolPlaces(), '/tool/places.json');
export const toolProcedureJson = (slug: string): string =>
  checked('tool-procedure', buildToolProcedure(slug), `/tool/procedures/${slug}.json`);

// Every source the tool's data file draws on, by credit key.
export const toolSources = (): string[] =>
  [
    ...new Set([
      ...readSurgeryIndexSources(),
      ...readHospitalSources(),
      ...(readDist('suburbs.json') as { sources: string[] }).sources,
    ]),
  ].sort(before);
