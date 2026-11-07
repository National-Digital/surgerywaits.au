import { describe, expect, it } from 'vitest';
import { splitRuns } from './dom';
import { historySpots } from './results';

describe('the history sparkline', () => {
  it('breaks the line at a year with no figure and joins only adjacent years', () => {
    const gapped = [2011, 9, ...Array<null>(11).fill(null), 5, 7] as const;
    const spots = historySpots(gapped);
    expect(spots).toHaveLength(14);
    expect(spots.filter((s) => s.y !== null)).toHaveLength(3);
    const runs = splitRuns(spots);
    expect(runs.map((r) => r.length)).toEqual([1, 2]);
    expect(runs[1]?.[0]?.x).toBeGreaterThan((runs[0]?.[0]?.x ?? 0) + 80);
  });

  it('breaks the line at a withheld figure', () => {
    const runs = splitRuns(historySpots([2019, 4, -1, 6, 8]));
    expect(runs.map((r) => r.length)).toEqual([1, 2]);
  });

  it('keeps one run when every year has a figure', () => {
    expect(splitRuns(historySpots([2020, 3, 4, 5])).map((r) => r.length)).toEqual([3]);
  });
});
