import { getHealthServiceTemplate, getHospitalTemplate } from './content';
import { listDist, readHealthServiceIndex, readHealthServiceIndexSources } from './dist';
import type { HealthService } from './dist';
import {
  formatCount,
  formatDate,
  formatFigure,
  formatPeriod,
  formatStamp,
  isPublished,
} from './format';
import type { Figure } from './format';
import { hospitalPath } from './hospital-page';
import { fill } from './slots';
import { categories } from './urgency-page';

export const HEALTH_SERVICES_PATH = '/health-service/';

export const healthServicePath = (slug: string): string => `${HEALTH_SERVICES_PATH}${slug}/`;

// The index and the network files must name the same networks, so no page is built from one alone.
export function healthServiceSlugs(): string[] {
  const indexed = readHealthServiceIndex()
    .map((row) => row.slug)
    .sort();
  if (indexed.join('\n') !== listDist('health-services').join('\n')) {
    throw new RangeError(
      'health-services.json and the health service files do not list the same networks',
    );
  }
  return indexed;
}

export const healthServiceRoutes = (): { params: { slug: string }; props: { slug: string } }[] =>
  healthServiceSlugs().map((slug) => ({ params: { slug }, props: { slug } }));

// The page holds a hospital's network link only when the network has a page.
export const networkPath = (slug: string): string | undefined =>
  readHealthServiceIndex().some((row) => row.slug === slug) ? healthServicePath(slug) : undefined;

// A stamp has no figure of its own to read from, so the words come from a figure that carries them.
const stampOf = (period: string, release: string): string =>
  formatStamp({ state: 'not_reported', reason: 'not_reported_by_source', period, release });

interface MemberCell {
  text: string;
  withheld: boolean;
}

interface MemberRow {
  name: string;
  href: string;
  cells: MemberCell[];
}

export interface MemberTable {
  rows: MemberRow[];
  // The newest period and release among the hospitals' figures, in words.
  stamp: string;
}

const collator = new Intl.Collator('en-AU');

// The newest period and release of any urgent figure or counted category, whatever its status.
function newestStamp(service: HealthService): { period: string; release: string } {
  const stamps = service.hospitals.flatMap(({ urgent_on_time: u, surgeries }) => [
    ...surgeries.current,
    ...(u.period === null || u.release === null ? [] : [{ period: u.period, release: u.release }]),
  ]);
  const newest = stamps.sort((a, b) => a.period.localeCompare(b.period)).at(-1);
  if (newest === undefined) {
    throw new RangeError(`${service.slug}: no hospital has a figure with a period`);
  }
  return newest;
}

// A current figure that is not the table's own period or release carries its own stamp.
function urgentCell(
  figure: Figure,
  newest: { period: string; release: string },
  cellStamp: string,
): MemberCell {
  const text = formatFigure('on_time', figure);
  const own = figure.period === newest.period && figure.release === newest.release;
  return {
    text: own ? text : fill(cellStamp, { text, stamp: stampOf(figure.period, figure.release) }),
    withheld: !isPublished(figure),
  };
}

export function memberTable(service: HealthService): MemberTable {
  const t = getHealthServiceTemplate();
  const newest = newestStamp(service);
  const rows = [...service.hospitals]
    .sort((a, b) => b.surgeries.count - a.surgeries.count || collator.compare(a.name, b.name))
    .map((member): MemberRow => {
      const u = member.urgent_on_time;
      // The caption's stamp covers the count, so a table with another period or release cannot share it.
      if (
        member.surgeries.current.some(
          (c) => c.period !== newest.period || c.release !== newest.release,
        )
      ) {
        throw new RangeError(
          `${member.slug}: a category count is not for the newest period and release`,
        );
      }
      let urgent: MemberCell;
      if (u.status === 'missing' || u.period === null || u.release === null) {
        urgent = { text: t.missing_cell, withheld: true };
      } else if (u.status === 'stale' || u.figure === null) {
        urgent = {
          text: fill(t.stale_cell, { stamp: stampOf(u.period, u.release) }),
          withheld: true,
        };
      } else {
        urgent = urgentCell(u.figure, newest, t.cell_stamp);
      }
      return {
        name: member.closed ? fill(t.closed_name, { name: member.name }) : member.name,
        href: hospitalPath(member.slug),
        cells: [
          { text: getHospitalTemplate().states[member.state], withheld: false },
          { text: formatCount(member.surgeries.count), withheld: false },
          urgent,
        ],
      };
    });
  return {
    rows,
    stamp: fill(t.table_stamp, {
      period: formatPeriod(newest.period),
      release: formatDate(newest.release),
    }),
  };
}

export const urgentCategory = (): ReturnType<typeof categories>[number] => {
  const first = categories()[0];
  if (first === undefined) {
    throw new RangeError('no urgency category');
  }
  return first;
};

export interface IndexGroup {
  state: string;
  id: string;
  networks: { name: string; href: string; hospitals: number }[];
}

// A network that spans states is listed under each; states follow the content's order.
export function indexGroups(order: readonly string[]): IndexGroup[] {
  const rows = readHealthServiceIndex();
  const known = new Set(order);
  const stray = rows.flatMap((row) => row.states).find((state) => !known.has(state));
  if (stray !== undefined) {
    throw new RangeError(`no name in content for the state ${stray}`);
  }
  return order
    .map((state) => ({
      state,
      id: state.toLowerCase(),
      networks: rows
        .filter((row) => (row.states as string[]).includes(state))
        .sort((a, b) => collator.compare(a.display_name, b.display_name))
        .map((row) => ({
          name: row.display_name,
          href: healthServicePath(row.slug),
          hospitals: row.hospitals,
        })),
    }))
    .filter((group) => group.networks.length > 0);
}

export const indexSources = (): string[] => [...readHealthServiceIndexSources()].sort();
