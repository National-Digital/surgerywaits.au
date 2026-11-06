import { getHospitalTemplate, getUrgencyTemplate } from './content';
import { listSurgeries, readSurgery } from './dist';
import type { Benchmark, BenchmarkSeries, Surgery, SurgeryRow } from './dist';
import { formatDate, formatPeriod, isPublished } from './format';
import type { Figure, Role } from './format';
import { hospitalPath, rankOf, sortedWithSpan } from './hospital-page';
import type { SurgeryTableModel } from './hospital-page';
import { fill } from './slots';
import { isCurrent, listable, NATIONAL } from './surgery-page';
import type { ChartSeries } from './chart';
import { sortRows } from './table';
import type { TableRow } from './table';

export const URGENCY_PATH = '/urgency/';

// The order a category is shown in: the share treated on time first, since the page ranks on it.
export const URGENCY_ROLES: readonly Role[] = ['on_time', 'median_wait', 'volume'];

export interface Category {
  slug: string;
  number: number;
  short: string;
  within: string;
  meaning: string;
  label: string;
  path: string;
}

const categoryPath = (number: number): string => `${URGENCY_PATH}category-${String(number)}/`;

export const categoryStatePath = (category: Pick<Category, 'path'>, state: string): string =>
  `${category.path}${state.toLowerCase()}/`;

// The hospital content names the dist's categories in order 1, 2, 3, and this content describes them in that order.
export function categories(): Category[] {
  const t = getUrgencyTemplate();
  const slugs = Object.keys(getHospitalTemplate().urgency);
  if (
    slugs.length !== t.categories.length ||
    [...slugs].sort().join('\n') !== listSurgeries('urgency').join('\n')
  ) {
    throw new RangeError('the urgency content and the urgency files do not match');
  }
  return t.categories.map((c, i) => {
    const number = i + 1;
    return {
      ...c,
      slug: slugs[i] ?? '',
      number,
      label: fill(t.category_label, { number: String(number), short: c.short }),
      path: categoryPath(number),
    };
  });
}

export const categoryByNumber = (number: number): Category => {
  const found = categories().find((c) => c.number === number);
  if (found === undefined) {
    throw new RangeError(`no urgency category ${String(number)}`);
  }
  return found;
};

export const readCategory = (category: Category): Surgery => readSurgery('urgency', category.slug);

// The states with an open hospital row, which are the states that get a category page of their own.
export const categoryStates = (surgery: Surgery): string[] =>
  [...new Set(listable(surgery).map((r) => r.state))].sort();

// A measure the source did not report reads "not reported", never a gap.
const absent = (surgery: Pick<Surgery, 'period' | 'release'>): Figure => ({
  state: 'not_reported',
  reason: 'not_reported_by_source',
  period: surgery.period,
  release: surgery.release,
});

export const publishedShares = (surgery: Surgery, rows: readonly SurgeryRow[]): number =>
  rows.filter(
    (r) => isCurrent(r, surgery) && isPublished(r.measures.on_time?.figure ?? absent(surgery)),
  ).length;

// Highest share treated on time first; every row that has no current published share follows.
export function categoryRows(
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
      cells: URGENCY_ROLES.map((role) => {
        const measure = row.measures[role];
        if (measure === undefined) {
          throw new RangeError(`${row.slug}: ${surgery.slug} has no ${role}`);
        }
        const rank = rankOf(measure, stale);
        return { figure: measure.figure, ...(rank === undefined ? {} : { rank }) };
      }),
    };
  });
  return sortedWithSpan(table, 'on_time');
}

export function benchmarkRows(
  surgery: Surgery,
  name: (state: string) => string,
  linked: ReadonlySet<string>,
  href: (state: string) => string,
): TableRow[] {
  const rows = surgery.benchmarks.states.map(({ state, measures }) => ({
    code: state,
    name: name(state),
    ...(linked.has(state) ? { href: href(state) } : {}),
    cells: URGENCY_ROLES.map((role) => ({ figure: measures[role] ?? absent(surgery) })),
  }));
  return sortRows(rows, 0, 'on_time');
}

export const benchmarkTiles = (
  measures: Benchmark | null | undefined,
): { role: Role; figure: Figure }[] =>
  URGENCY_ROLES.flatMap((role) => {
    const figure = measures?.[role];
    return figure === undefined ? [] : [{ role, figure }];
  });

export interface BenchmarkChart {
  id: string;
  role: Role;
  series: ChartSeries[];
}

const TREND_ROLES: readonly Role[] = ['on_time', 'median_wait'];

// Series that share a release and periods can share a chart; any other gets its own.
export function benchmarkCharts(
  surgery: Surgery,
  scopes: readonly string[],
  names: Record<string, string>,
): BenchmarkChart[] {
  return TREND_ROLES.flatMap((role) => {
    const groups = new Map<string, ChartSeries[]>();
    for (const scope of scopes) {
      const found: BenchmarkSeries | undefined = surgery.benchmarks.trends.find(
        (s) => s.scope === scope && s.role === role,
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
      id: `chart-${role.replace('_', '-')}-${String(i)}`,
      role,
      series,
    }));
  });
}

export const NATIONAL_SCOPE = NATIONAL;

export const categoryRoutes = (): { params: { category: string }; props: { number: number } }[] =>
  categories().map((c) => ({
    params: { category: `category-${String(c.number)}` },
    props: { number: c.number },
  }));

export const categoryStateRoutes = (): {
  params: { category: string; state: string };
  props: { number: number; state: string };
}[] =>
  categories().flatMap((c) =>
    categoryStates(readCategory(c)).map((state) => ({
      params: { category: `category-${String(c.number)}`, state: state.toLowerCase() },
      props: { number: c.number, state },
    })),
  );

// Every category comes from one table, so they share one period and release, which the index states once.
export function urgencyStamp(): { period: string; release: string } {
  const all = categories().map((c) => readCategory(c));
  const first = all[0];
  if (
    first === undefined ||
    all.some((s) => s.period !== first.period || s.release !== first.release)
  ) {
    throw new RangeError('the urgency categories must share one period and release');
  }
  return { period: formatPeriod(first.period), release: formatDate(first.release) };
}

export const urgencySources = (): string[] =>
  [...new Set(categories().flatMap((c) => readCategory(c).sources))].sort();

export function categoryPathOf(slug: string): string {
  const found = categories().find((c) => c.slug === slug);
  if (found === undefined) {
    throw new RangeError(`no urgency page for ${slug}`);
  }
  return found.path;
}
