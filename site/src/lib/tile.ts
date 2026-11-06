// A stale or withheld figure is never ranked or compared, so a caller that passes one is wrong.
export function assertCurrent(current: boolean, claimsMore: boolean): void {
  if (!current && claimsMore) {
    throw new RangeError('a rank or a change belongs only to a current published figure');
  }
}
