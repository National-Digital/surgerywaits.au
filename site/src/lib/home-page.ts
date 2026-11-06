import { readHospitalIndex, readSurgery } from './dist';
import { isPublished } from './format';
import type { Figure, Role } from './format';
import { stateFiles } from './state-page';
import { surgeryPath, surgeryRefs } from './surgery-page';
import { categories } from './urgency-page';
import type { TableRow } from './table';

export const COMMON_COUNT = 10;

// One heading for each column of the common surgeries table: the median wait, then the patients treated.
export const commonColumns = (headings: readonly string[]): { heading: string; role: Role }[] =>
  (['median_wait', 'volume'] as const).map((role, i) => ({ role, heading: headings[i] ?? '' }));

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

// The procedures with a published national volume, most patients first, so the table names no figure the source withheld.
export function commonProcedures(count = COMMON_COUNT): { rows: TableRow[]; sources: string[] } {
  const found = surgeryRefs()
    .filter((ref) => ref.kind === 'procedure')
    .flatMap((ref) => {
      const surgery = readSurgery(ref.kind, ref.slug);
      const volume = surgery.benchmarks.national?.volume;
      if (volume === undefined || !isPublished(volume) || volume.state !== 'published') {
        return [];
      }
      const median: Figure = surgery.benchmarks.national?.median_wait ?? {
        state: 'not_reported',
        reason: 'not_reported_by_source',
        period: surgery.period,
        release: surgery.release,
      };
      return [{ ref, volume, median, sources: surgery.sources }];
    })
    .sort((a, b) => b.volume.value - a.volume.value || (a.ref.urlSlug < b.ref.urlSlug ? -1 : 1))
    .slice(0, count);
  const rows: TableRow[] = found.map(({ ref, volume, median }) => ({
    code: ref.urlSlug,
    name: ref.name,
    href: surgeryPath(ref),
    cells: [{ figure: median }, { figure: volume }],
  }));
  return {
    rows,
    sources: [...new Set(found.flatMap((f) => f.sources))],
  };
}
