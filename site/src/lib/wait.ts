export type WaitDays = number | null;

// A suppressed cell arrives as null and always reads "not published", never 0 or blank.
export function formatWaitDays(days: WaitDays): string {
  if (days === null) {
    return 'not published';
  }
  return days === 1 ? '1 day' : `${days.toString()} days`;
}
