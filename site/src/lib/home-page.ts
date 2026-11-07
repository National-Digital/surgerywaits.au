import { readHospitalIndex, readSurgery, readSurgeryIndex } from './dist';
import { formatCount, formatDays, formatFigure, formatStamp, isPublished } from './format';
import type { Figure } from './format';
import { fill } from './slots';
import { getHospitalTemplate } from './content';
import { hospitalGroups, hospitalStamp, reportingCounts, surgeryStamp } from './index-pages';
import { stateFiles, stateName, statePath, statesStamp } from './state-page';
import { surgeryPath, surgeryRefs } from './surgery-page';
import { categories } from './urgency-page';

export const COMMON_COUNT = 20;

interface PlainCell {
  text: string;
  withheld: boolean;
}

interface PlainRow {
  name: string;
  href: string;
  cells: PlainCell[];
}

export interface PlainTable {
  rows: PlainRow[];
  stamp: string;
}

export interface HomeCounts {
  surgeries: number;
  hospitals: number;
  states: number;
  categories: number;
}

export const homeCounts = (): HomeCounts => ({
  surgeries: surgeryRefs().length,
  hospitals: readHospitalIndex().length,
  states: stateFiles().length,
  categories: categories().length,
});

// A plain first word drops to lower case mid-sentence; an acronym, a possessive or any other proper noun keeps its capital.
export const midSentence = (name: string): string =>
  /^[A-Z][a-z]+([-/][a-z]+)*,?(\s|$)/.test(name)
    ? `${name.charAt(0).toLowerCase()}${name.slice(1)}`
    : name;

const collator = new Intl.Collator('en-AU');

const figureCell = (role: 'median_wait' | 'volume', figure: Figure): PlainCell => ({
  text: formatFigure(role, figure),
  withheld: !isPublished(figure),
});

// The surgery types that the most hospitals reported in the newest period, with names in order within a tie.
export function commonProcedures(count = COMMON_COUNT): PlainTable & { sources: string[] } {
  const index = readSurgeryIndex().filter((row) => row.kind === 'procedure');
  const newest = index
    .map((row) => row.newest_period)
    .sort()
    .at(-1);
  const refs = new Map(surgeryRefs().map((ref) => [`${ref.kind}/${ref.slug}`, ref]));
  const chosen = index
    .filter((row) => row.newest_period === newest)
    .sort(
      (a, b) =>
        b.hospitals - a.hospitals ||
        collator.compare(a.name, b.name) ||
        (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
    )
    .slice(0, count);
  if (chosen.length < count) {
    throw new RangeError(
      `the home page table needs ${String(count)} surgery types and the data holds ${String(chosen.length)}`,
    );
  }
  const stamps = new Set<string>();
  const sources = new Set<string>();
  const rows = chosen.map((row): PlainRow => {
    const ref = refs.get(`${row.kind}/${row.slug}`);
    if (ref === undefined) {
      throw new RangeError(`no surgery page for ${row.kind}/${row.slug}`);
    }
    const surgery = readSurgery(row.kind, row.slug);
    const national = surgery.benchmarks.national;
    const absent: Figure = {
      state: 'not_reported',
      reason: 'not_reported_by_source',
      period: surgery.period,
      release: surgery.release,
    };
    const median = national?.median_wait ?? absent;
    const volume = national?.volume ?? absent;
    stamps.add(formatStamp(median));
    stamps.add(formatStamp(volume));
    surgery.sources.forEach((s) => sources.add(s));
    return {
      name: ref.name,
      href: surgeryPath(ref),
      cells: [
        figureCell('median_wait', median),
        figureCell('volume', volume),
        { text: formatCount(row.hospitals), withheld: false },
      ],
    };
  });
  if (stamps.size !== 1) {
    throw new RangeError('the rows of the home page table must share one period and release');
  }
  return { rows, stamp: [...stamps][0] ?? '', sources: [...sources] };
}

// One row for each state: the hospitals that report, the surgery types, and the shortest and longest state median.
export function stateSummary(extreme: string): PlainTable {
  const refs = surgeryRefs();
  const groups = hospitalGroups(Object.keys(getHospitalTemplate().states));
  const reportingIn = (state: string): number =>
    reportingCounts(groups.filter((group) => group.state === state)).reporting;
  const rows = stateFiles().map((file): PlainRow => {
    const ranked = file.surgeries
      .filter((s) => s.kind === 'procedure')
      .flatMap((s) => {
        const median = s.measures.median_wait;
        const ref = refs.find((r) => r.kind === s.kind && r.slug === s.slug);
        return median?.state === 'published' && ref !== undefined
          ? [{ wait: median.value, ref }]
          : [];
      })
      .sort(
        (a, b) =>
          a.wait - b.wait ||
          (a.ref.urlSlug < b.ref.urlSlug ? -1 : a.ref.urlSlug > b.ref.urlSlug ? 1 : 0),
      );
    const shortest = ranked.at(0);
    const longest = ranked.find((r) => r.wait === ranked.at(-1)?.wait);
    if (shortest === undefined || longest === undefined) {
      throw new RangeError(`the state ${file.state} has no published median wait to summarise`);
    }
    const cell = (entry: NonNullable<typeof shortest>): PlainCell => ({
      text: fill(extreme, { wait: formatDays(entry.wait), surgery: midSentence(entry.ref.name) }),
      withheld: false,
    });
    return {
      name: stateName(file.state),
      href: statePath(file.state),
      cells: [
        { text: formatCount(reportingIn(file.state)), withheld: false },
        { text: formatCount(ranked.length), withheld: false },
        cell(shortest),
        cell(longest),
      ],
    };
  });
  const { period, release } = statesStamp();
  const register = hospitalStamp();
  if (register.period !== period || register.release !== release) {
    throw new RangeError(
      'the state table counts hospitals from the register, so the register and the state files must share one period and release',
    );
  }
  return { rows, stamp: `${period}, released ${release}` };
}

// One sentence for each scope, and one release date when the surgery data and the hospital register share it.
export function homeStamps(
  t: { stamp_shared: string; stamp: string; hospitals_stamp: string },
  surgery = surgeryStamp(),
  hospitals = hospitalStamp(),
): string {
  if (surgery.period === hospitals.period && surgery.release === hospitals.release) {
    return fill(t.stamp_shared, surgery);
  }
  return `${fill(t.stamp, surgery)} ${fill(t.hospitals_stamp, hospitals)}`;
}
