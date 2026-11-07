import { getAreas, getSurgeryNames } from './content';
import type { LabelKey } from './content-schema';
import {
  distDirectory,
  listSurgeries,
  readHospitalIndex,
  readSurgery,
  readSurgeryIndex,
} from './dist';
import type { Benchmark, BenchmarkSeries, Kind, Surgery, SurgeryRow } from './dist';
import { distanceKm } from './geo';
import { isPublished } from './format';
import type { Figure, Role } from './format';
import { hospitalPath, rankOf, sortedWithSpan, TABLE_ROLES } from './hospital-page';
import type { SurgeryTableModel } from './hospital-page';
import type { ChartSeries } from './chart';
import { sortRows } from './table';
import type { TableRow } from './table';

export type PageKind = Exclude<Kind, 'urgency'>;

export const SURGERY_PATH = '/surgery/';
export const SPECIALTY_PATH = '/specialty/';

// The national trend series is named by the source's scope code for the whole country.
export const NATIONAL = 'NAT';

export const KINDS = { procedure: 'procedure', specialty: 'specialty' } as const;

export interface Route {
  slug: string;
  state?: string;
  area?: string;
}

const DIRECTORY: Record<PageKind, string> = { procedure: '/surgery/', specialty: '/specialty/' };

export const NEAR_RADIUS_KM = 25;
// The widest the hospitals on one page may spread, edge to edge, so every one is a real option for the others.
export const MAX_SPREAD_KM = 120;
export const MIN_RANKED = 2;
export const MAX_OUTSIDE = 2;
// A place with fewer pages than this is too thin to stand as a place of its own.
export const MIN_PLACE_PAGES = 3;
export const SMALL_STATE = 5;

const stateSlug = (state: string): string => state.toLowerCase();

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');

export interface SurgeryRef {
  kind: PageKind;
  slug: string;
  // The address the earlier site used where an everyday name earned one.
  urlSlug: string;
  name: string;
  source: string;
  renamed: boolean;
}

// Keyed by the dist directory, so a test that points at another dist reads its own surgeries.
const refs = new Map<string, SurgeryRef[]>();
const distKey = distDirectory;

export function surgeryRefs(): SurgeryRef[] {
  const cached = refs.get(distKey());
  if (cached !== undefined) {
    return cached;
  }
  const names = getSurgeryNames();
  const all = readSurgeryIndex()
    .filter((row): row is typeof row & { kind: PageKind } => row.kind !== 'urgency')
    .map((row): SurgeryRef => {
      const lay = row.kind === 'procedure' ? names[row.slug] : undefined;
      return {
        kind: row.kind,
        slug: row.slug,
        urlSlug: lay?.slug ?? row.slug,
        name: lay?.name ?? row.name,
        source: row.name,
        renamed: lay !== undefined,
      };
    });
  const seen = new Set<string>();
  for (const ref of all) {
    const key = surgeryPath(ref);
    if (seen.has(key)) {
      throw new RangeError(`two surgeries share the address ${key}`);
    }
    seen.add(key);
  }
  const files = (['procedure', 'specialty'] as const).flatMap((kind) =>
    listSurgeries(kind).map((slug) => `${kind}/${slug}`),
  );
  if (
    all
      .map((r) => `${r.kind}/${r.slug}`)
      .sort()
      .join('\n') !== files.sort().join('\n')
  ) {
    throw new RangeError('surgeries.json and the surgery files do not list the same surgeries');
  }
  refs.set(distKey(), all);
  return all;
}

export const refOf = (kind: PageKind, urlSlug: string): SurgeryRef => {
  const found = surgeryRefs().find((r) => r.kind === kind && r.urlSlug === urlSlug);
  if (found === undefined) {
    throw new RangeError(`no ${kind} at ${urlSlug}`);
  }
  return found;
};

export const surgeryPath = (ref: Pick<SurgeryRef, 'kind' | 'urlSlug'>): string =>
  `${DIRECTORY[ref.kind]}${ref.urlSlug}/`;

export const statePath = (ref: Pick<SurgeryRef, 'kind' | 'urlSlug'>, state: string): string =>
  `${surgeryPath(ref)}${stateSlug(state)}/`;

export const nearPath = (ref: Pick<SurgeryRef, 'kind' | 'urlSlug'>, area: string): string =>
  `${surgeryPath(ref)}near/${area}/`;

// Every row is in the table's newest period, so a row whose figures say otherwise counts as earlier.
export const isCurrent = (row: SurgeryRow, surgery: Surgery): boolean =>
  Object.values(row.measures).every(
    (m) => m.figure.period === surgery.period && m.figure.release === surgery.release,
  );

// A closed hospital is left off the ranked lists, and its own page keeps its past figures.
export const listable = (surgery: Surgery): SurgeryRow[] =>
  surgery.hospitals.filter((r) => !r.closed);

export function hospitalRows(
  surgery: Surgery,
  rows: readonly SurgeryRow[],
): SurgeryTableModel | null {
  if (rows.length === 0) {
    return null;
  }
  const table: TableRow[] = rows.map((row) => {
    const stale = !isCurrent(row, surgery);
    return {
      code: row.slug,
      name: row.name,
      href: hospitalPath(row.slug),
      stale,
      cells: TABLE_ROLES.map((role) => {
        const measure = row.measures[role];
        if (measure === undefined) {
          throw new RangeError(`${row.slug}: ${surgery.slug} has no ${role}`);
        }
        const rank = rankOf(measure, stale);
        return { figure: measure.figure, ...(rank === undefined ? {} : { rank }) };
      }),
    };
  });
  return sortedWithSpan(table);
}

export const publishedMedians = (surgery: Surgery, rows: readonly SurgeryRow[]): number =>
  rows.filter((r) => isCurrent(r, surgery) && isPublished(r.measures.median_wait?.figure ?? NONE))
    .length;

const NONE: Figure = {
  state: 'not_reported',
  reason: 'not_reported_by_source',
  period: '',
  release: '',
};

// A role the source did not report for a benchmark reads "not reported", never a gap.
export function benchmarkCells(
  surgery: Surgery,
  measures: Benchmark | null,
): { role: Role; figure: Figure }[] {
  return TABLE_ROLES.map((role) => ({
    role,
    figure: measures?.[role] ?? {
      state: 'not_reported',
      reason: 'not_reported_by_source',
      period: surgery.period,
      release: surgery.release,
    },
  }));
}

export function stateTable(
  surgery: Surgery,
  name: (state: string) => string,
  linked: ReadonlySet<string>,
  href: (state: string) => string,
): TableRow[] {
  const rows = surgery.benchmarks.states.map(({ state, measures }) => ({
    code: state,
    name: name(state),
    ...(linked.has(state) ? { href: href(state) } : {}),
    cells: benchmarkCells(surgery, measures).map(({ figure }) => ({ figure })),
  }));
  return sortRows(rows, 0, 'median_wait');
}

export const nationalTiles = (measures: Benchmark | null): { role: Role; figure: Figure }[] =>
  TABLE_ROLES.flatMap((role) => {
    const figure = measures?.[role];
    return figure === undefined ? [] : [{ role, figure }];
  });

// The states with hospitals on the page, which are the states that get a page of their own.
export const statesWithRows = (surgery: Surgery): string[] =>
  [...new Set(listable(surgery).map((r) => r.state))].sort();

export function trendScope(
  surgery: Surgery,
  scopes: readonly string[],
  names: Record<string, string>,
): { id: string; series: ChartSeries[] }[] {
  const groups = new Map<string, ChartSeries[]>();
  for (const scope of scopes) {
    const found: BenchmarkSeries | undefined = surgery.benchmarks.trends.find(
      (s) => s.scope === scope && s.role === 'median_wait',
    );
    if (found === undefined) {
      continue;
    }
    const key = `${found.release}|${found.periods.join()}`;
    groups.set(key, [
      ...(groups.get(key) ?? []),
      {
        name: names[scope] ?? scope,
        release: found.release,
        periods: found.periods,
        points: found.points,
      },
    ]);
  }
  return [...groups.values()].map((series, i) => ({
    id: `chart-median-wait-${String(i)}`,
    series,
  }));
}

// The three states that treated the most patients, by the measured volume.
export function busiestStates(surgery: Surgery, count = 3): string[] {
  return surgery.benchmarks.states
    .flatMap(({ state, measures }) => {
      const volume = measures.volume;
      return volume?.state === 'published' ? [{ state, value: volume.value }] : [];
    })
    .sort((a, b) => b.value - a.value || (a.state < b.state ? -1 : 1))
    .slice(0, count)
    .map((s) => s.state)
    .sort();
}

export interface NearArea {
  slug: string;
  place: string;
  prose: string;
  network: string;
  anchor: string;
  state: string;
  rows: SurgeryRow[];
  hasOutside: boolean;
}

interface Located {
  code: string;
  position: { latitude: number; longitude: number };
}

const rankable = (row: SurgeryRow, surgery: Surgery): boolean =>
  !row.closed && isCurrent(row, surgery) && isPublished(row.measures.median_wait?.figure ?? NONE);

function located(): {
  byCode: Map<string, Located>;
  index: ReturnType<typeof readHospitalIndex>;
} {
  const index = readHospitalIndex();
  const byCode = new Map<string, Located>();
  for (const h of index) {
    if (h.latitude !== null && h.longitude !== null) {
      byCode.set(h.code, {
        code: h.code,
        position: { latitude: h.latitude, longitude: h.longitude },
      });
    }
  }
  return { byCode, index };
}

// The places that can name a page for one surgery, before the places with too few pages are dropped.
function areasFor(surgery: Surgery): NearArea[] {
  const config = getAreas();
  const { byCode, index } = located();
  const rowOf = new Map(surgery.hospitals.map((r) => [r.code, r]));
  const childrenOnly = (code: string, network: string | undefined): boolean =>
    config.children_only_hospitals.includes(code) ||
    (network !== undefined && config.children_only_networks.includes(network));
  const networkOf = new Map(index.map((h) => [h.code, h.network?.code]));
  const out: NearArea[] = [];
  for (const place of config.areas) {
    const members = index.filter((h) => h.network?.code === place.network);
    if (members.length === 0) {
      continue;
    }
    const anchor = members.find((m) => m.code === place.hospital);
    const centre = byCode.get(place.hospital);
    // A hospital missing from the dist leaves its place without a page, as a place with no hospitals does.
    if (anchor === undefined || centre === undefined) {
      continue;
    }
    const open = members.filter((m) => !m.closed && !childrenOnly(m.code, place.network));
    const near = open.filter((m) => {
      const at = byCode.get(m.code);
      return at !== undefined && distanceKm(centre.position, at.position) <= NEAR_RADIUS_KM;
    });
    // A network that mostly lies farther out cannot lend its name to one cluster of it.
    if (open.length < 2 || near.length * 2 < open.length) {
      continue;
    }
    const inside = near.flatMap((m) => rowOf.get(m.code) ?? []);
    const ranked = inside.filter((r) => rankable(r, surgery));
    if (ranked.length < MIN_RANKED) {
      continue;
    }
    const memberCodes = new Set(members.map((m) => m.code));
    const outside = surgery.hospitals
      .filter((r) => !memberCodes.has(r.code) && rankable(r, surgery) && byCode.has(r.code))
      .filter((r) => !childrenOnly(r.code, networkOf.get(r.code)))
      .flatMap((r) => {
        const at = byCode.get(r.code);
        const km = Math.min(
          ...ranked.map((a) => {
            const to = byCode.get(a.code);
            return at === undefined || to === undefined
              ? Infinity
              : distanceKm(to.position, at.position);
          }),
        );
        return km <= NEAR_RADIUS_KM ? [{ row: r, km }] : [];
      })
      .sort((a, b) => a.km - b.km || (a.row.name < b.row.name ? -1 : 1))
      .slice(0, Math.min(MAX_OUTSIDE, ranked.length - 1))
      .map((e) => e.row);
    const listed = [...ranked, ...outside];
    const within = (row: SurgeryRow, others: readonly SurgeryRow[]): boolean =>
      others.every((o) => {
        const a = byCode.get(row.code);
        const b = byCode.get(o.code);
        return (
          a !== undefined && b !== undefined && distanceKm(a.position, b.position) <= MAX_SPREAD_KM
        );
      });
    if (!listed.every((r) => within(r, listed))) {
      continue;
    }
    for (const row of inside
      .filter((r) => !ranked.includes(r))
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (within(row, listed)) {
        listed.push(row);
      }
    }
    const state = [...new Set(inside.map((r) => r.state))].sort()[0] ?? '';
    const listedCodes = new Set(listed.map((r) => r.code));
    const statewide = surgery.hospitals.filter(
      (r) => r.state === state && !childrenOnly(r.code, networkOf.get(r.code)),
    );
    const missing = statewide.filter((r) => !listedCodes.has(r.code)).length;
    const crossBorder = listed.some((r) => r.state !== state);
    // A page that would repeat the state page's list adds nothing.
    if (missing === 0 || (statewide.length <= SMALL_STATE && missing <= 1 && !crossBorder)) {
      continue;
    }
    out.push({
      slug: slugify(place.place),
      place: place.place,
      prose: place.article === true ? `the ${place.place}` : place.place,
      network: anchor.network?.name ?? '',
      anchor: anchor.name,
      state,
      rows: listed,
      hasOutside: outside.length > 0,
    });
  }
  return out;
}

export const NEAR = { radius: NEAR_RADIUS_KM };

let nearCache: { key: string; map: Map<string, NearArea[]> } | undefined;

// Places are kept only when enough surgeries give them a page, so the set depends on every procedure.
export function nearAreas(): Map<string, NearArea[]> {
  const key = distKey();
  if (nearCache?.key === key) {
    return nearCache.map;
  }
  const all = surgeryRefs()
    .filter((r) => r.kind === 'procedure')
    .map((ref) => ({ ref, areas: areasFor(readSurgery(ref.kind, ref.slug)) }));
  const pages = new Map<string, number>();
  for (const { areas } of all) {
    for (const a of areas) {
      pages.set(a.slug, (pages.get(a.slug) ?? 0) + 1);
    }
  }
  const map = new Map(
    all.map(({ ref, areas }) => [
      ref.urlSlug,
      areas.filter((a) => (pages.get(a.slug) ?? 0) >= MIN_PLACE_PAGES),
    ]),
  );
  nearCache = { key, map };
  return map;
}

export function roleLabels(label: (key: LabelKey) => string): Record<Role, string> {
  return {
    median_wait: label('role_median_wait'),
    volume: label('role_volume'),
    long_wait: label('role_long_wait'),
    on_time: label('role_on_time'),
  };
}

export const hubRoutes = (kind: PageKind): { params: Route; props: Route }[] =>
  surgeryRefs()
    .filter((ref) => ref.kind === kind)
    .map(({ urlSlug }) => ({ params: { slug: urlSlug }, props: { slug: urlSlug } }));

export const stateRoutes = (
  kind: PageKind,
): {
  params: Required<Pick<Route, 'slug' | 'state'>>;
  props: Required<Pick<Route, 'slug' | 'state'>>;
}[] =>
  surgeryRefs()
    .filter((ref) => ref.kind === kind)
    .flatMap((ref) =>
      statesWithRows(readSurgery(ref.kind, ref.slug)).map((state) => ({
        params: { slug: ref.urlSlug, state: stateSlug(state) },
        props: { slug: ref.urlSlug, state },
      })),
    );

export const nearRoutes = (): {
  params: Required<Pick<Route, 'slug' | 'area'>>;
  props: Required<Pick<Route, 'slug' | 'area'>>;
}[] =>
  [...nearAreas()].flatMap(([slug, areas]) =>
    areas.map((a) => ({ params: { slug, area: a.slug }, props: { slug, area: a.slug } })),
  );

export function nearArea(ref: SurgeryRef, slug: string): NearArea {
  const found = nearAreas()
    .get(ref.urlSlug)
    ?.find((a) => a.slug === slug);
  if (found === undefined) {
    throw new RangeError(`${ref.urlSlug} has no page near ${slug}`);
  }
  return found;
}

export interface IndexGroup {
  kind: PageKind;
  id: string;
  items: { ref: SurgeryRef; hospitals: number; period: string }[];
}

// Groups follow the order of the kinds, and each is in name order.
export function indexGroups(): IndexGroup[] {
  const index = readSurgeryIndex();
  const entries = surgeryRefs().map((ref) => {
    const row = index.find((r) => r.kind === ref.kind && r.slug === ref.slug);
    return { ref, hospitals: row?.hospitals ?? 0, period: row?.newest_period ?? '' };
  });
  return (['procedure', 'specialty'] as const).map((kind) => ({
    kind,
    id: `${kind}-heading`,
    items: entries
      .filter((e) => e.ref.kind === kind)
      .sort((a, b) => a.ref.name.localeCompare(b.ref.name, 'en-AU')),
  }));
}
