import { formatStamp, isPublished } from './format';
import type { Figure } from './format';
import { spanStamp } from './table';
import type { Span } from './table';

export interface RankCell {
  text: string;
  href?: string | undefined;
  // The link's accessible name where the same text leads to different pages.
  label?: string | undefined;
  // A small line under the text, such as a state and a figure.
  note?: string | undefined;
  // The figure the cell shows, so the table can check its stamp.
  figure?: Figure | undefined;
  // The cell that names the row, which is a row header.
  heading?: boolean | undefined;
}

export interface RankRow {
  key: string;
  cells: RankCell[];
  // The published figures the row's order stands on.
  basis: Figure[];
}

export interface RankingModel {
  columns: string[];
  rows: RankRow[];
  span?: Span | undefined;
}

// The stamp the table states: one period and release, or the span it names.
export function assertRanking({ columns, rows, span }: RankingModel): string {
  const stamps = new Set<string>();
  for (const row of rows) {
    if (row.cells.length !== columns.length) {
      throw new RangeError('a row needs one cell for each column');
    }
    if (row.basis.length === 0 || !row.basis.every(isPublished)) {
      throw new RangeError('a row is ordered only on current published figures');
    }
    for (const figure of [...row.basis, ...row.cells.flatMap((c) => c.figure ?? [])]) {
      stamps.add(formatStamp(figure));
      if (
        span !== undefined &&
        (figure.release !== span.release || figure.period < span.first || figure.period > span.last)
      ) {
        throw new RangeError('a figure falls outside the period range or release the table states');
      }
    }
  }
  if (span !== undefined) {
    return spanStamp(span);
  }
  if (stamps.size !== 1) {
    throw new RangeError('the rows of a table must share one period and release');
  }
  return [...stamps][0] ?? '';
}

// Equal values share a position, and the next position skips the places they took.
export function competitionRanks(values: readonly number[]): number[] {
  return values.map((value) => 1 + values.filter((other) => other > value).length);
}
