import { getHospitalTemplate } from './content';
import {
  distDirectory,
  listDist,
  readHospitalIndex,
  readQueenslandFacility,
  readQueenslandIndex,
  readState,
  readSurgery,
} from './dist';
import type { StateBenchmarks, StateSurgery } from './dist';
import {
  formatDate,
  formatPeriod,
  formatQuarter,
  formatQueenslandFigure,
  formatStamp,
  isPublished,
} from './format';
import type { Figure, QueenslandFigure, Role } from './format';
import { hospitalPath, rankOf, sortedWithSpan } from './hospital-page';
import type { SurgeryTableModel } from './hospital-page';
import { categories, categoryStates, readCategory } from './urgency-page';
import type { Category } from './urgency-page';
import {
  isCurrent,
  listable,
  statePath as surgeryStatePath,
  statesWithRows,
  surgeryRefs,
} from './surgery-page';
import type { SurgeryRef } from './surgery-page';
import type { TableRow } from './table';

export const STATES_PATH = '/state/';
const OVERLAY_STATE = 'Qld';

const stateSlug = (state: string): string => state.toLowerCase();
export const statePath = (state: string): string => `${STATES_PATH}${stateSlug(state)}/`;

// The order the content names the states in, which is the order the pages list them.
export function stateFiles(): StateBenchmarks[] {
  const order = Object.keys(getHospitalTemplate().states);
  const files = listDist('states').map((slug) => readState(slug));
  return files.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
}

export const stateRoutes = (): { params: { state: string }; props: { state: string } }[] =>
  stateFiles().map(({ state }) => ({ params: { state: stateSlug(state) }, props: { state } }));

export const loadState = (state: string): StateBenchmarks => readState(stateSlug(state));

// The newest period any state file reports, with the release that goes with it.
export function statesStamp(): { period: string; release: string } {
  const newest = stateFiles()
    .flatMap((file) => file.surgeries)
    .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0))[0];
  if (newest === undefined) {
    throw new RangeError('the state pages need a period and a release date');
  }
  return { period: formatPeriod(newest.period), release: formatDate(newest.release) };
}

export const newestPeriod = (file: StateBenchmarks): string =>
  file.surgeries
    .map((s) => s.period)
    .sort()
    .at(-1) ?? '';

const states = (): Record<string, string> => getHospitalTemplate().states;

export const stateName = (state: string): string => {
  const name = states()[state];
  if (name === undefined) {
    throw new RangeError(`no name in content for the state ${state}`);
  }
  return name;
};

const NO_FIGURE = (surgery: Pick<StateSurgery, 'period' | 'release'>): Figure => ({
  state: 'not_reported',
  reason: 'not_reported_by_source',
  period: surgery.period,
  release: surgery.release,
});

// Which states have a page for each surgery, read once for the whole build.
const linkedCache = new Map<string, Map<string, Set<string>>>();

function linkedStates(): Map<string, Set<string>> {
  const key = distDirectory();
  const cached = linkedCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const map = new Map(
    surgeryRefs().map((ref) => [
      `${ref.kind}/${ref.slug}`,
      new Set(statesWithRows(readSurgery(ref.kind, ref.slug))),
    ]),
  );
  linkedCache.set(key, map);
  return map;
}

const refFor = (surgery: StateSurgery): SurgeryRef => {
  const found = surgeryRefs().find((r) => r.kind === surgery.kind && r.slug === surgery.slug);
  if (found === undefined) {
    throw new RangeError(`no surgery page for ${surgery.kind}/${surgery.slug}`);
  }
  return found;
};

const STATE_COLUMNS: readonly { role: Role; own: boolean }[] = [
  { role: 'median_wait', own: true },
  { role: 'median_wait', own: false },
  { role: 'long_wait', own: true },
  { role: 'volume', own: true },
];

// One heading for each column of a surgery table, in the order STATE_COLUMNS gives.
export const surgeryColumns = (headings: readonly string[]): { heading: string; role: Role }[] =>
  STATE_COLUMNS.map(({ role }, i) => ({ heading: headings[i] ?? '', role }));

export const hospitalColumns = (
  cats: readonly Category[],
  heading: (category: Category) => string,
): { heading: string; role: Role }[] =>
  cats.map((category) => ({ heading: heading(category), role: 'median_wait' }));

export const procedureTable = (file: StateBenchmarks): SurgeryTableModel | null =>
  surgeryTable(file, 'procedure');

export const specialtyTable = (file: StateBenchmarks): SurgeryTableModel | null =>
  surgeryTable(file, 'specialty');

function surgeryTable(
  file: StateBenchmarks,
  kind: 'procedure' | 'specialty',
): SurgeryTableModel | null {
  const linked = linkedStates();
  const rows: TableRow[] = file.surgeries
    .filter((s) => s.kind === kind)
    .map((surgery) => {
      const ref = refFor(surgery);
      const here = linked.get(`${ref.kind}/${ref.slug}`)?.has(file.state) === true;
      return {
        code: ref.urlSlug,
        name: ref.name,
        ...(here ? { href: surgeryStatePath(ref, file.state) } : {}),
        cells: STATE_COLUMNS.map(({ role, own }) => ({
          figure: (own ? surgery.measures : surgery.national)?.[role] ?? NO_FIGURE(surgery),
        })),
      };
    });
  return rows.length === 0 ? null : sortedWithSpan(rows);
}

export interface HeadlineTile {
  surgery: string;
  state: Figure;
  national: Figure;
}

// The procedures that treated the most patients in the state, with a published median in both places.
export function headlineTiles(file: StateBenchmarks, count = 3): HeadlineTile[] {
  return file.surgeries
    .filter((s) => s.kind === 'procedure')
    .flatMap((surgery) => {
      const volume = surgery.measures.volume;
      const state = surgery.measures.median_wait;
      const national = surgery.national?.median_wait;
      if (
        volume?.state !== 'published' ||
        state === undefined ||
        national === undefined ||
        !isPublished(state) ||
        !isPublished(national)
      ) {
        return [];
      }
      return [{ ref: refFor(surgery), volume: volume.value, state, national }];
    })
    .sort((a, b) => b.volume - a.volume || (a.ref.urlSlug < b.ref.urlSlug ? -1 : 1))
    .slice(0, count)
    .map(({ ref, state, national }) => ({ surgery: ref.name, state, national }));
}

export interface HospitalTable extends SurgeryTableModel {
  count: number;
}

// One row for each open hospital with an urgency figure, and a cell for each category.
export function hospitalTable(state: string): (HospitalTable & { categories: Category[] }) | null {
  const cats = categories();
  const surgeries = cats.map((c) => ({ category: c, surgery: readCategory(c) }));
  const slugs = new Set(
    surgeries.flatMap(({ surgery }) =>
      listable(surgery)
        .filter((r) => r.state === state)
        .map((r) => r.slug),
    ),
  );
  const rows: TableRow[] = [...slugs].map((slug) => {
    const found = surgeries.map(({ surgery }) => ({
      surgery,
      row: listable(surgery).find((r) => r.slug === slug),
    }));
    const name = found.find((f) => f.row !== undefined)?.row?.name ?? slug;
    const current = found.map((f) => f.row !== undefined && isCurrent(f.row, f.surgery));
    const stale = !current.some(Boolean);
    return {
      code: slug,
      name,
      href: hospitalPath(slug),
      stale,
      cells: found.map(({ surgery, row }, i) => {
        const measure = row?.measures.median_wait;
        // A cell from an earlier period in a row that has a current one reads "not reported".
        if (measure === undefined || (!stale && current[i] !== true)) {
          return { figure: NO_FIGURE(surgery) };
        }
        const rank = rankOf(measure, stale);
        return { figure: measure.figure, ...(rank === undefined ? {} : { rank }) };
      }),
    };
  });
  if (rows.length === 0) {
    return null;
  }
  return { ...sortedWithSpan(rows), count: rows.length, categories: cats };
}

export function publishedUrgencyCount(state: string): number {
  const first = categories()[0];
  if (first === undefined) {
    return 0;
  }
  const surgery = readCategory(first);
  return listable(surgery).filter(
    (r) =>
      r.state === state &&
      isCurrent(r, surgery) &&
      r.measures.median_wait !== undefined &&
      isPublished(r.measures.median_wait.figure),
  ).length;
}

// The categories that have a page for this state.
export const urgencyLinks = (state: string): Category[] =>
  categories().filter((c) => categoryStates(readCategory(c)).includes(state));

export const hospitalsIn = (state: string): ReturnType<typeof readHospitalIndex> =>
  readHospitalIndex()
    .filter((h) => h.state === state)
    .sort((a, b) => a.name.localeCompare(b.name, 'en-AU') || (a.slug < b.slug ? -1 : 1));

export const surgeryCount = (file: StateBenchmarks): number =>
  file.surgeries.filter((s) => isPublished(s.measures.median_wait ?? NO_FIGURE(s))).length;

interface QueenslandCell {
  text: string;
  withheld: boolean;
}

interface QueenslandRow {
  name: string;
  href?: string;
  treated: QueenslandCell;
  timely: QueenslandCell;
}

const qldCell = (
  column: 'treated' | 'percent_treated_in_time',
  figure: QueenslandFigure,
): QueenslandCell => ({
  text: formatQueenslandFigure(column, figure),
  withheld: figure.state !== 'published',
});

export interface QueenslandSummary {
  quarter: string;
  stamp: string;
  rows: QueenslandRow[];
}

// The newest quarter's all-surgery totals for each joined facility, in name order and never ranked.
function queenslandSummary(): QueenslandSummary | null {
  const index = readQueenslandIndex();
  const newest = index.quarters
    .map((q) => q.period_end)
    .sort()
    .at(-1);
  const have = new Set(listDist('queensland'));
  const found = index.facilities.flatMap((facility) => {
    const code = facility.hospital_code.toLowerCase();
    const quarter = have.has(code)
      ? readQueenslandFacility(code).quarters.find((q) => q.period_end === newest)
      : undefined;
    return quarter === undefined ? [] : [{ facility, quarter }];
  });
  const first = found[0]?.quarter.total.treated;
  if (newest === undefined || first === undefined) {
    return null;
  }
  const stamps = new Set(
    found.flatMap(({ quarter }) =>
      [quarter.total.treated, quarter.total.percent_treated_in_time].map(formatStamp),
    ),
  );
  if (stamps.size !== 1) {
    throw new RangeError('the Queensland figures of one quarter must share a period and a release');
  }
  const rows = found.map(({ facility, quarter }): QueenslandRow => {
    const name =
      facility.slug === null
        ? facility.facility_name
        : (hospitalName(facility.slug) ?? facility.facility_name);
    return {
      name,
      ...(facility.slug === null ? {} : { href: hospitalPath(facility.slug) }),
      treated: qldCell('treated', quarter.total.treated),
      timely: qldCell('percent_treated_in_time', quarter.total.percent_treated_in_time),
    };
  });
  return {
    quarter: formatQuarter(newest),
    stamp: formatStamp(first),
    rows: rows.sort((a, b) => a.name.localeCompare(b.name, 'en-AU')),
  };
}

// The overlay belongs to one state, so no other state's page holds it.
export const overlayFor = (state: string): QueenslandSummary | null =>
  state === OVERLAY_STATE ? queenslandSummary() : null;

function hospitalName(slug: string): string | undefined {
  return readHospitalIndex().find((h) => h.slug === slug)?.name;
}

// The state file's sources, with those of the urgency tables and, for Queensland, the overlay.
export function sourcesOf(file: StateBenchmarks, state: string): string[] {
  return [
    ...new Set([
      ...file.sources,
      ...categories().flatMap((c) => readCategory(c).sources),
      ...(state === 'Qld' ? readQueenslandIndex().sources : []),
    ]),
  ].sort();
}
