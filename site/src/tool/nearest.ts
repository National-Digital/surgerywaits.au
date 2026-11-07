import { distanceKm } from '../lib/geo';

export interface Located {
  hospital: number;
  latitude: number;
  longitude: number;
}

// Great-circle distance, then the hospital's place in code order, as the pipeline orders its neighbours.
export function nearest<T extends Located>(
  rows: readonly T[],
  from: { latitude: number; longitude: number },
  count: number,
): { row: T; km: number }[] {
  return rows
    .map((row) => ({ row, km: distanceKm(from, row) }))
    .sort((a, b) => a.km - b.km || a.row.hospital - b.row.hospital)
    .slice(0, count);
}
