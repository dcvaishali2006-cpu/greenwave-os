/**
 * Where the five simulated junctions sit on the map.
 *
 * PLACEHOLDER: a straight east-west corridor of five junctions about 250 m apart near Hubballi, Karnataka.
 * Replace these with the real junctions of the corridor your team picks: open OpenStreetMap, right-click the
 * junction, "Show address", copy the coordinates. Keep the order west to east (J1 is the eastbound entry).
 */
export const CORRIDOR: { id: string; name: string; lat: number; lng: number }[] = [
 { id: 'J1', name: 'Junction 1', lat: 15.8592, lng: 74.5079 },
{ id: 'J2', name: 'Junction 2', lat: 15.8609, lng: 74.5075 },
{ id: 'J3', name: 'Junction 3', lat: 15.8671, lng: 74.511 },
{ id: 'J4', name: 'Junction 4', lat: 15.8662, lng: 74.5185 },
{ id: 'J5', name: 'Junction 5', lat: 15.8626, lng: 74.5239 },
];

/** Queue length (vehicles) to a colour: free flow, building, jammed. */
export const queueColor = (q: number) => (q >= 12 ? '#DC2626' : q >= 5 ? '#F97316' : '#14B8A6');
export const GREEN = '#22C55E';
export const AMBER = '#F59E0B';
export const RED = '#EF4444';

export const fmtClock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
