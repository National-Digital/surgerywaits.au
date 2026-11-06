const EARTH_KM = 6371;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

export interface Position {
  latitude: number;
  longitude: number;
}

// Great-circle distance, which is what a straight line on the map means.
export function distanceKm(a: Position, b: Position): number {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}
