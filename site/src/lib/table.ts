import { formatDate, formatPeriod, formatStamp, isPublished } from './format';
import { assertCurrent } from './tile';
import type { Figure, Role } from './format';

export interface TableCell {
  figure: Figure;
  rank?: { position: number; of: number };
}

export interface TableRow {
  code: string;
  name: string;
  href?: string;
  stale?: boolean;
  cells: TableCell[];
}

// Lower is better for waits, higher for on-time shares; a volume sorts largest first.
const LOWER_FIRST: Record<Role, boolean> = {
  median_wait: true,
  long_wait: true,
  on_time: false,
  volume: false,
};

// The table states one period and release, so a current figure that differs cannot share the stamp.
function tableStamp(rows: readonly TableRow[]): string {
  const stamps = new Set(
    rows
      .filter((row) => row.stale !== true)
      .flatMap((row) => row.cells.map((c) => formatStamp(c.figure))),
  );
  if (stamps.size !== 1) {
    throw new RangeError('the current rows of a table must share one period and release');
  }
  return [...stamps][0] ?? '';
}

// A table across periods names the first and last period and the one release; the words are built here.
export interface Span {
  first: string;
  last: string;
  release: string;
}

export function spanStamp(span: Span): string {
  if (span.first === '' || span.last === '' || span.first > span.last || span.release === '') {
    throw new RangeError('a span needs a first period, a last period after it, and a release');
  }
  return `${formatPeriod(span.first)} to ${formatPeriod(span.last)}, released ${formatDate(span.release)}`;
}

function assertWithin(rows: readonly TableRow[], span: Span): void {
  for (const row of rows.filter((r) => r.stale !== true)) {
    for (const { figure } of row.cells) {
      if (
        figure.release !== span.release ||
        figure.period < span.first ||
        figure.period > span.last
      ) {
        throw new RangeError('a figure falls outside the period range or release the table states');
      }
    }
  }
}

export function assertTable(
  columns: readonly unknown[],
  rows: readonly TableRow[],
  span?: Span,
): string {
  const stamp = span === undefined ? tableStamp(rows) : spanStamp(span);
  if (span !== undefined) {
    assertWithin(rows, span);
  }
  for (const row of rows) {
    if (row.cells.length !== columns.length) {
      throw new RangeError('a row needs one cell for each column');
    }
    for (const cell of row.cells) {
      assertCurrent(isPublished(cell.figure) && row.stale !== true, cell.rank !== undefined);
    }
  }
  return stamp;
}

export function pairCells(
  columns: readonly { role: Role }[],
  row: TableRow,
): { role: Role; cell: TableCell }[] {
  return columns.map((column, i) => {
    const cell = row.cells[i];
    if (cell === undefined) {
      throw new RangeError('a row needs one cell for each column');
    }
    return { role: column.role, cell };
  });
}

export function tableIds(id: string): { caption: string; hint: string } {
  return { caption: `${id}-caption`, hint: `${id}-hint` };
}

function measured(row: TableRow, column: number): number | null {
  const figure = row.cells[column]?.figure;
  return row.stale !== true && figure?.state === 'published' ? figure.value : null;
}

const byCode = (a: TableRow, b: TableRow): number =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

// Rows with a current measured value come first by that value; every tie, and every other row, falls to its code.
export function sortRows(rows: readonly TableRow[], column: number, role: Role): TableRow[] {
  const direction = LOWER_FIRST[role] ? 1 : -1;
  const ranked = rows.flatMap((row) => {
    const value = measured(row, column);
    return value === null ? [] : [{ row, value }];
  });
  ranked.sort((a, b) => direction * (a.value - b.value) || byCode(a.row, b.row));
  const rest = rows.filter((row) => measured(row, column) === null).sort(byCode);
  return [...ranked.map((r) => r.row), ...rest];
}
