import { CORRIDOR } from './corridor';

/** Map position for a corridor coordinate (0 = J1, 1 = J2 ...). Values outside the range continue the first or last road segment. */
export function corridorPoint(pos: number): [number, number] {
  const i = Math.max(0, Math.min(CORRIDOR.length - 2, Math.floor(pos)));
  const a = CORRIDOR[i];
  const b = CORRIDOR[i + 1];
  const f = pos - i;
  return [a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f];
}
