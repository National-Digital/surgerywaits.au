import type { getHomeTemplate } from './content';
import { formatCount, formatDayParts, formatDays, formatKilometres } from './format';
import {
  BORDER_PATH,
  CHANGES_PATH,
  LONGEST_PATH,
  borderPairs,
  longestEntries,
  longestStamp,
  movePeriods,
  stateMoves,
} from './longest-page';
import type { BorderPair, Entry, Move } from './longest-page';
import { midSentence } from './home-page';
import { fill } from './slots';
import { stateName } from './state-page';

export interface ProofTile {
  amount: string;
  unit: string;
  sentence: string;
  href: string;
  link: string;
}

export interface ProofSource {
  longest: Entry | undefined;
  // How many rows the longest-waits page shows, ties at the last rank included.
  longestCount: number;
  border: BorderPair | undefined;
  move: Move | undefined;
  period: string;
  previous: string;
}

// The first row of each longest-waits page, so a test can hand in its own rows.
function proofSource(): ProofSource {
  return {
    longest: longestEntries(1)[0],
    longestCount: longestEntries().length,
    border: borderPairs(1)[0],
    move: stateMoves()[0],
    period: longestStamp().period,
    previous: movePeriods().previous,
  };
}

type ProofText = ReturnType<typeof getHomeTemplate>;

// A tile whose source is absent is left out, so the strip never shows a figure it cannot source.
export function proofTiles(t: ProofText, source: ProofSource = proofSource()): ProofTile[] {
  const { longest, longestCount, border, move, period, previous } = source;
  const tiles: ProofTile[] = [];
  if (longest !== undefined) {
    tiles.push({
      ...formatDayParts(longest.figure.value),
      sentence: fill(t.proof_longest, {
        surgery: longest.ref.name,
        hospital: longest.row.name,
        period,
      }),
      href: LONGEST_PATH,
      link: fill(t.proof_longest_link, { count: formatCount(longestCount) }),
    });
  }
  if (border !== undefined) {
    tiles.push({
      ...formatDayParts(border.difference),
      sentence: fill(t.proof_border, {
        surgery: midSentence(border.ref.name),
        days: formatDays(border.difference),
        distance: formatKilometres(Math.round(border.km)),
        from_hospital: border.from.row.name,
        from_state: stateName(border.from.row.state),
        to_hospital: border.to.row.name,
        to_state: stateName(border.to.row.state),
        period,
      }),
      href: BORDER_PATH,
      link: t.proof_border_link,
    });
  }
  // A move of zero days is no move, so it gets no tile.
  if (move !== undefined && move.change !== 0) {
    tiles.push({
      ...formatDayParts(move.from.value, move.to.value),
      sentence: fill(move.change > 0 ? t.proof_move_up : t.proof_move_down, {
        surgery: move.ref.name,
        state: stateName(move.state),
        previous,
        period,
      }),
      href: CHANGES_PATH,
      link: t.proof_move_link,
    });
  }
  return tiles;
}

// The heading states the real tile count.
export function proofHeading(t: ProofText, count: number): string {
  if (count < 1 || count > 3) {
    throw new RangeError('the heading counts one to three tiles');
  }
  if (count === 3) {
    return t.proof_heading_three;
  }
  return count === 2 ? t.proof_heading_two : t.proof_heading_one;
}
