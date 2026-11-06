import { readCredits } from './credits';
import { readHospital, readHospitalIndex, readSurgeryIndex } from './dist';
import type { HospitalIndexRow } from './dist';
import { formatDate, formatPeriod } from './format';
import { hospitalPath } from './hospital-page';

export const URGENCY_ID = 'urgency-heading';

const collator = new Intl.Collator('en-AU', { sensitivity: 'base' });
const byName = (a: { name: string }, b: { name: string }): number =>
  collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export interface IndexItem {
  name: string;
  href?: string | undefined;
  // Small type lines under the name.
  notes?: string[] | undefined;
  // A word that marks the item, so a mark never rests on colour alone.
  tag?: string | undefined;
}

interface HospitalEntry {
  slug: string;
  name: string;
  href: string;
  closed: boolean;
  alternativeNames: string[];
  // Procedure types with a current figure, and with only an earlier one.
  current: number;
  earlier: number;
  reporting: boolean;
}

export interface StateGroup {
  state: HospitalIndexRow['state'];
  id: string;
  hospitals: HospitalEntry[];
}

function detail(
  row: HospitalIndexRow,
): Pick<HospitalEntry, 'alternativeNames' | 'current' | 'earlier' | 'reporting'> {
  const hospital = readHospital(row.slug);
  const procedures = hospital.surgeries.filter((surgery) => surgery.kind === 'procedure');
  return {
    alternativeNames: hospital.alternative_names
      .filter((other) => collator.compare(other, row.name) !== 0)
      .sort(collator.compare),
    current: procedures.filter((surgery) => !surgery.stale).length,
    earlier: procedures.filter((surgery) => surgery.stale).length,
    reporting: hospital.surgeries.some((surgery) => !surgery.stale),
  };
}

// States come in the order given, so the page follows the content's order, and an empty one is dropped.
export function hospitalGroups(order: readonly string[]): StateGroup[] {
  const rows = readHospitalIndex();
  const known = new Set(order);
  const stray = rows.find((row) => !known.has(row.state));
  if (stray !== undefined) {
    throw new RangeError(`no name in content for the state ${stray.state}`);
  }
  return order
    .map((state) => ({
      state: state as HospitalIndexRow['state'],
      id: state.toLowerCase(),
      hospitals: rows
        .filter((row) => row.state === state)
        .sort(byName)
        .map((row) => ({
          slug: row.slug,
          name: row.name,
          href: hospitalPath(row.slug),
          closed: row.closed,
          ...detail(row),
        })),
    }))
    .filter((group) => group.hospitals.length > 0);
}

// The newest period any category reports, with the release date of the table the counts come from.
export function surgeryStamp(): { period: string; release: string } {
  const periods = readSurgeryIndex()
    .map((row) => row.newest_period)
    .sort();
  const period = periods.at(-1);
  const release = readCredits().find(
    (c) => c.slug === 'au-elective-surgery-waiting-times-by-procedure',
  )?.as_at;
  if (period === undefined || release === null || release === undefined) {
    throw new RangeError('the surgery counts need a period and a release date');
  }
  return { period: formatPeriod(period), release: formatDate(release) };
}

// The register's newest period and release, which every count on the hospital list comes from.
export function hospitalStamp(): { period: string; release: string } {
  const period = readHospitalIndex()
    .map((row) => row.latest_period)
    .sort()
    .at(-1);
  const release = readCredits().find((c) => c.slug === 'au-hospitals-myhospitals')?.as_at;
  if (period === undefined || release === null || release === undefined) {
    throw new RangeError('the hospital counts need a period and a release date');
  }
  return { period: formatPeriod(period), release: formatDate(release) };
}

// A hospital reports when at least one of its surgeries has a current figure.
export function reportingCounts(groups: readonly StateGroup[]): { reporting: number; not: number } {
  const all = groups.flatMap((group) => group.hospitals);
  const reporting = all.filter((h) => h.reporting).length;
  return { reporting, not: all.length - reporting };
}

// Categories follow the order of the content's names, which is 1, 2, 3, and not the source's order.
export function urgencyEntries(
  names: Readonly<Record<string, string>>,
): { label: string; hospitals: number; period: string }[] {
  const rows = readSurgeryIndex().filter((row) => row.kind === 'urgency');
  return Object.entries(names).map(([slug, label]) => {
    const row = rows.find((r) => r.slug === slug);
    if (row === undefined) {
      throw new RangeError(`no urgency category ${slug} in the surgery index`);
    }
    return { label, hospitals: row.hospitals, period: row.newest_period };
  });
}
