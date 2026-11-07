import {
  distDirectory,
  listDist,
  readHospital,
  readHospitalIndex,
  readSurgery,
  readTrend,
} from './dist';
import type { HospitalIndexRow, Surgery, SurgeryRow } from './dist';
import { distanceKm } from './geo';
import { formatDate, formatPeriod, formatPeriodStartingIn } from './format';
import type { PublishedFigure } from './format';
import { pairPath } from './pair-page';
import { stateFiles, statePath as stateHubPath } from './state-page';
import {
  isCurrent,
  listable,
  statePath as surgeryStatePath,
  statesWithRows,
  surgeryPath,
  surgeryRefs,
} from './surgery-page';
import type { SurgeryRef } from './surgery-page';

export const LONGEST_PATH = '/longest-waits/';
export const BY_SURGERY_PATH = '/longest-waits/by-surgery/';
export const BORDER_PATH = '/longest-waits/border/';
export const CHANGES_PATH = '/longest-waits/changes/';

export const LONGEST_COUNT = 50;
export const BORDER_COUNT = 25;
export const CHANGE_COUNT = 15;
// A hospital with fewer surgeries than this can swing by hundreds of days on a handful of cases.
export const MOVE_VOLUME_FLOOR = 50;
export const BORDER_RADIUS_KM = 100;
// A procedure needs this many reporting hospitals to have a shortest and a longest median.
export const MIN_EXTREMES = 2;

const collator = new Intl.Collator('en-AU');
const byText = (a: string, b: string): number =>
  collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export const stateCode = (state: string): string => state.toUpperCase();

interface Procedure {
  ref: SurgeryRef;
  surgery: Surgery;
}

const cache = new Map<string, Procedure[]>();

// Only procedures are ranked here, since a specialty groups many procedures under one figure.
function procedures(): Procedure[] {
  const key = distDirectory();
  const found = cache.get(key);
  if (found !== undefined) {
    return found;
  }
  const all = surgeryRefs()
    .filter((ref) => ref.kind === 'procedure')
    .map((ref) => ({ ref, surgery: readSurgery('procedure', ref.slug) }));
  cache.set(key, all);
  return all;
}

// Every table here comes from one release, so the pages state one period and release.
export function longestStamp(): {
  period: string;
  release: string;
  raw: { period: string; release: string };
} {
  const first = procedures()[0]?.surgery;
  if (
    first === undefined ||
    procedures().some(
      ({ surgery }) => surgery.period !== first.period || surgery.release !== first.release,
    )
  ) {
    throw new RangeError('the procedures must share one period and release');
  }
  return {
    period: formatPeriod(first.period),
    release: formatDate(first.release),
    raw: { period: first.period, release: first.release },
  };
}

export interface Entry {
  ref: SurgeryRef;
  row: SurgeryRow;
  figure: PublishedFigure;
}

// A row stands in a ranking only when it is open, current and has a published median.
export function rankable(ref: SurgeryRef, surgery: Surgery): Entry[] {
  return listable(surgery)
    .filter((row) => isCurrent(row, surgery))
    .flatMap((row) => {
      const figure = row.measures.median_wait?.figure;
      return figure?.state === 'published' ? [{ ref, row, figure }] : [];
    });
}

const allRankable = (): Entry[] =>
  procedures().flatMap(({ ref, surgery }) => rankable(ref, surgery));

// A list cut at a count keeps every row that ties the last one shown, so no tie is split.
export function withTies<T>(sorted: readonly T[], count: number, key: (item: T) => number): T[] {
  const last = sorted[count - 1];
  if (last === undefined) {
    return [...sorted];
  }
  const edge = key(last);
  return sorted.filter((item, i) => i < count || key(item) === edge);
}

const byLongest = (a: Entry, b: Entry): number =>
  b.figure.value - a.figure.value ||
  byText(a.row.name, b.row.name) ||
  byText(a.ref.slug, b.ref.slug);

export const longestEntries = (count = LONGEST_COUNT): Entry[] =>
  withTies(allRankable().sort(byLongest), count, (e) => e.figure.value);

export interface Extremes {
  ref: SurgeryRef;
  shortest: Entry;
  longest: Entry;
  reporting: number;
  // Other hospitals that published the same median as the one named at each end.
  shortestTied: number;
  longestTied: number;
}

const byShortest = (a: Entry, b: Entry): number =>
  a.figure.value - b.figure.value ||
  byText(a.row.name, b.row.name) ||
  byText(a.ref.slug, b.ref.slug);

// Where hospitals tie at an end, the sort puts the first name at the shortest end and the last at the longest.
export function extremes(): Extremes[] {
  return procedures()
    .flatMap(({ ref, surgery }) => {
      const entries = rankable(ref, surgery).sort(byShortest);
      const shortest = entries[0];
      const longest = entries.at(-1);
      if (shortest === undefined || longest === undefined || entries.length < MIN_EXTREMES) {
        return [];
      }
      const sharing = (end: Entry): number =>
        entries.filter((e) => e.figure.value === end.figure.value).length - 1;
      return [
        {
          ref,
          shortest,
          longest,
          reporting: entries.length,
          shortestTied: sharing(shortest),
          longestTied: sharing(longest),
        },
      ];
    })
    .sort((a, b) => byText(a.ref.name, b.ref.name) || byText(a.ref.slug, b.ref.slug));
}

export const spread = (e: Extremes): number => e.longest.figure.value - e.shortest.figure.value;

export const widest = (all: readonly Extremes[]): Extremes | undefined =>
  [...all].sort((a, b) => spread(b) - spread(a) || byText(a.ref.slug, b.ref.slug))[0];

export interface BorderPair {
  ref: SurgeryRef;
  from: Entry;
  to: Entry;
  km: number;
  difference: number;
}

// Each open hospital's open neighbours in other states within the radius, found once from the index.
const neighbours = new Map<string, Map<string, Map<string, number>>>();

function crossBorder(): Map<string, Map<string, number>> {
  const key = distDirectory();
  const found = neighbours.get(key);
  if (found !== undefined) {
    return found;
  }
  const located = readHospitalIndex().filter(
    (h): h is HospitalIndexRow & { latitude: number; longitude: number } =>
      !h.closed && h.latitude !== null && h.longitude !== null,
  );
  const map = new Map<string, Map<string, number>>();
  for (const a of located) {
    const near = new Map<string, number>();
    for (const b of located) {
      if (a.state === b.state) {
        continue;
      }
      const km = distanceKm(a, b);
      if (km <= BORDER_RADIUS_KM) {
        near.set(b.slug, km);
      }
    }
    map.set(a.slug, near);
  }
  neighbours.set(key, map);
  return map;
}

export function borderPairs(count = BORDER_COUNT): BorderPair[] {
  const near = crossBorder();
  const found: BorderPair[] = [];
  for (const { ref, surgery } of procedures()) {
    const entries = rankable(ref, surgery);
    const bySlug = new Map(entries.map((e) => [e.row.slug, e]));
    for (const from of entries) {
      let best: BorderPair | undefined;
      for (const [slug, km] of near.get(from.row.slug) ?? []) {
        const to = bySlug.get(slug);
        const difference = to === undefined ? 0 : from.figure.value - to.figure.value;
        if (to === undefined || difference <= 0) {
          continue;
        }
        if (
          best === undefined ||
          difference > best.difference ||
          (difference === best.difference &&
            (km < best.km || (km === best.km && byText(to.row.slug, best.to.row.slug) < 0)))
        ) {
          best = { ref, from, to, km, difference };
        }
      }
      if (best !== undefined) {
        found.push(best);
      }
    }
  }
  found.sort(
    (a, b) =>
      b.difference - a.difference ||
      byText(a.from.row.name, b.from.row.name) ||
      byText(a.ref.slug, b.ref.slug),
  );
  return withTies(found, count, (p) => p.difference);
}

export interface Move {
  ref: SurgeryRef;
  state: string;
  hospital?: { slug: string; name: string } | undefined;
  from: PublishedFigure;
  to: PublishedFigure;
  change: number;
  href: string;
  stateHref?: string | undefined;
}

type Point = readonly [year: number, value: number | null, change: number | null, tag?: string];

// The current year's point and the one before it, when the source published both.
function pairOfPoints(
  periods: readonly string[],
  points: readonly Point[],
  period: string,
): { before: { period: string; value: number }; now: { period: string; value: number } } | null {
  const at = periods.indexOf(period);
  const now = points[at];
  const before = points[at - 1];
  const nowValue = now?.[1];
  const beforeValue = before?.[1];
  if (
    at < 1 ||
    now === undefined ||
    before === undefined ||
    nowValue === null ||
    nowValue === undefined ||
    beforeValue === null ||
    beforeValue === undefined ||
    now[0] !== before[0] + 1
  ) {
    return null;
  }
  return {
    before: { period: periods[at - 1] ?? '', value: beforeValue },
    now: { period, value: nowValue },
  };
}

export const byBiggest = (a: Move, b: Move): number =>
  Math.abs(b.change) - Math.abs(a.change) ||
  byText(a.state, b.state) ||
  byText(a.hospital?.name ?? '', b.hospital?.name ?? '') ||
  byText(a.ref.slug, b.ref.slug);

const published = (value: number, period: string, release: string): PublishedFigure => ({
  state: 'published',
  value,
  period,
  release,
});

export function stateMoves(): Move[] {
  const states = new Set<string>(stateFiles().map((file) => file.state));
  return procedures()
    .flatMap(({ ref, surgery }) => {
      const linked = new Set(statesWithRows(surgery));
      return surgery.benchmarks.trends
        .filter((series) => series.role === 'median_wait' && series.scope !== 'NAT')
        .flatMap((series) => {
          const found = pairOfPoints(series.periods, series.points, surgery.period);
          if (found === null || series.release !== surgery.release) {
            return [];
          }
          const state = series.scope;
          return [
            {
              ref,
              state,
              from: published(found.before.value, found.before.period, series.release),
              to: published(found.now.value, found.now.period, series.release),
              change: found.now.value - found.before.value,
              href: linked.has(state) ? surgeryStatePath(ref, state) : surgeryPath(ref),
              ...(states.has(state) ? { stateHref: stateHubPath(state) } : {}),
            },
          ];
        });
    })
    .sort(byBiggest);
}

const hospitalMovesCache = new Map<string, Move[]>();

// Open hospitals with a current published median and volume, and the same median a year earlier.
export function hospitalMoves(): Move[] {
  const key = distDirectory();
  const cached = hospitalMovesCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const { raw } = longestStamp();
  const withTrend = new Set(listDist('trends'));
  const refs = new Map(procedures().map(({ ref }) => [ref.slug, ref]));
  const found: Move[] = [];
  for (const index of readHospitalIndex().filter((h) => !h.closed && withTrend.has(h.slug))) {
    const hospital = readHospital(index.slug);
    const trend = readTrend(index.slug);
    for (const surgery of hospital.surgeries) {
      const ref = refs.get(surgery.slug);
      const volume = surgery.measures.volume?.figure;
      const median = surgery.measures.median_wait?.figure;
      const series = trend.series.find(
        (s) => s.kind === 'procedure' && s.slug === surgery.slug && s.role === 'median_wait',
      );
      if (series === undefined) {
        continue;
      }
      if (
        surgery.kind !== 'procedure' ||
        surgery.stale ||
        ref === undefined ||
        series.release !== raw.release ||
        median?.state !== 'published' ||
        volume?.state !== 'published' ||
        volume.value < MOVE_VOLUME_FLOOR
      ) {
        continue;
      }
      const pair = pairOfPoints(series.periods, series.points, raw.period);
      // The trend and the hospital's figure come from one release, so they must agree.
      if (pair === null) {
        continue;
      }
      if (pair.now.value !== median.value) {
        continue;
      }
      found.push({
        ref,
        state: index.state,
        hospital: { slug: index.slug, name: index.name },
        from: published(pair.before.value, pair.before.period, series.release),
        to: published(pair.now.value, pair.now.period, series.release),
        change: pair.now.value - pair.before.value,
        href: pairPath(index.slug, ref),
      });
    }
  }
  found.sort(byBiggest);
  hospitalMovesCache.set(key, found);
  return found;
}

export const rises = (moves: readonly Move[], count = CHANGE_COUNT): Move[] =>
  withTies(
    moves.filter((m) => m.change > 0),
    count,
    (m) => m.change,
  );
export const falls = (moves: readonly Move[], count = CHANGE_COUNT): Move[] =>
  withTies(
    moves.filter((m) => m.change < 0),
    count,
    (m) => m.change,
  );

export function movePeriods(): { previous: string; period: string; release: string } {
  const { raw } = longestStamp();
  const year = Number(raw.period.slice(0, 4));
  return { previous: formatPeriodStartingIn(year - 1), period: raw.period, release: raw.release };
}

export function longestSources(): string[] {
  return [...new Set(procedures().flatMap(({ surgery }) => surgery.sources))].sort();
}
