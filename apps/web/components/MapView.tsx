'use client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { AMBER, CORRIDOR, GREEN, RED, queueColor } from '@/lib/corridor';
import type { JunctionState, NetworkState } from '@/lib/types';

const lamp = (j: JunctionState, axis: 0 | 1) => (j.phase !== axis ? RED : j.mode === 'green' ? GREEN : AMBER);

/** One junction: lamps on the four sides of a box, with the queue length of each approach beside its lamp. */
function markerHtml(j: JunctionState, selected: boolean, scale: number) {
  const pill = (q: number, pos: string) =>
    `<div style="position:absolute;${pos};min-width:22px;height:18px;padding:0 5px;border-radius:9px;background:${queueColor(q)};color:#fff;font:600 11px ui-monospace,monospace;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.5)">${q}</div>`;
  const dot = (c: string, pos: string) => `<div style="position:absolute;${pos};width:10px;height:10px;border-radius:50%;background:${c};box-shadow:0 0 8px ${c}"></div>`;
  const ew = lamp(j, 0);
  const ns = lamp(j, 1);
  const a = j.approaches;
  return `<div class="gw-marker" data-id="${j.id}" style="position:relative;width:96px;height:96px;cursor:pointer;transform:scale(${scale});transform-origin:center">
    <div style="position:absolute;left:30px;top:30px;width:36px;height:36px;border-radius:8px;background:#0B1020;border:2px solid ${selected ? '#8B5CF6' : '#334155'};display:flex;align-items:center;justify-content:center;color:#E5E7EB;font:700 12px Inter,sans-serif;${selected ? 'box-shadow:0 0 0 3px rgba(139,92,246,.35)' : ''}">${j.id}</div>
    ${dot(ns, 'left:43px;top:19px')}${dot(ns, 'left:43px;top:67px')}${dot(ew, 'left:19px;top:43px')}${dot(ew, 'left:67px;top:43px')}
    ${pill(a.SB.queue, 'left:37px;top:-1px')}${pill(a.NB.queue, 'left:37px;top:79px')}${pill(a.EB.queue, 'left:-2px;top:39px')}${pill(a.WB.queue, 'left:76px;top:39px')}
  </div>`;
}

export default function MapView({ state, selected, onSelect }: { state: NetworkState | null; selected: string | null; onSelect: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<Record<string, L.Marker>>({});
  const lines = useRef<L.Polyline[]>([]);
  const cross = useRef<Record<string, L.Polyline>>({});
  const pick = useRef(onSelect);
  pick.current = onSelect;
  const latest = useRef({ state, selected });
  latest.current = { state, selected };

  /** Redraw markers and road colours from the latest state. Markers shrink as the map zooms out so they never overlap. */
  const paint = useRef(() => {});
  paint.current = () => {
    const m = map.current;
    const { state: s, selected: sel } = latest.current;
    if (!m || !s) return;
    const scale = Math.min(1, 1.6 * 2 ** (m.getZoom() - 16));
    const by = Object.fromEntries(s.junctions.map((j) => [j.id, j]));
    for (const c of CORRIDOR) {
      const j = by[c.id];
      if (!j) continue;
      markers.current[c.id]?.setIcon(L.divIcon({ className: '', html: markerHtml(j, sel === c.id, scale), iconSize: [96, 96], iconAnchor: [48, 48] }));
      cross.current[c.id]?.setStyle({ color: queueColor(Math.max(j.approaches.NB.queue, j.approaches.SB.queue)) });
    }
    lines.current.forEach((line, i) => {
      const a = by[CORRIDOR[i].id];
      const b = by[CORRIDOR[i + 1].id];
      if (a && b) line.setStyle({ color: queueColor(Math.max(b.approaches.EB.queue, a.approaches.WB.queue)) });
    });
  };

  // Create the map once.
  useEffect(() => {
    if (!host.current || map.current) return;
    const m = L.map(host.current, { zoomControl: true, scrollWheelZoom: true, attributionControl: true, zoomSnap: 0.25 });
    map.current = m;
    m.on('zoomend', () => paint.current());
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(m);
    // Fit the corridor to the map. Done again once the container has its final size (the grid settles after first paint),
    // and whenever the container is resized, until the user moves the map themselves.
    let userMoved = false;
    const fit = () => {
      m.invalidateSize();
      const narrow = m.getSize().x < 700;
      m.fitBounds(L.latLngBounds(CORRIDOR.map((c) => [c.lat, c.lng] as [number, number])), { padding: narrow ? [40, 40] : [60, 60], maxZoom: 17, animate: false });
    };
    fit();
    const ro = new ResizeObserver(() => {
      if (!userMoved) fit();
    });
    ro.observe(host.current);
    // Any touch, click or wheel on the map means the user is driving it: stop re-fitting.
    for (const ev of ['pointerdown', 'wheel'] as const) host.current.addEventListener(ev, () => (userMoved = true), { passive: true });

    for (let i = 0; i < CORRIDOR.length - 1; i++) {
      lines.current.push(L.polyline([[CORRIDOR[i].lat, CORRIDOR[i].lng], [CORRIDOR[i + 1].lat, CORRIDOR[i + 1].lng]], { color: '#14B8A6', weight: 7, opacity: 0.85 }).addTo(m));
    }
    for (const c of CORRIDOR) {
      cross.current[c.id] = L.polyline([[c.lat + 0.0013, c.lng], [c.lat - 0.0013, c.lng]], { color: '#14B8A6', weight: 5, opacity: 0.75 }).addTo(m);
      const mk = L.marker([c.lat, c.lng], { icon: L.divIcon({ className: '', html: '', iconSize: [96, 96], iconAnchor: [48, 48] }), keyboard: true, title: c.name }).addTo(m);
      mk.on('click', () => pick.current(c.id));
      markers.current[c.id] = mk;
    }
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      markers.current = {};
      lines.current = [];
      cross.current = {};
    };
  }, []);

  // Repaint on every tick.
  useEffect(() => {
    paint.current();
  }, [state, selected]);

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full bg-ink" aria-label="Live map of the corridor" />
      <div className="pointer-events-none absolute bottom-3 right-3 z-[500] hidden rounded-lg md:block border border-line bg-panel/90 px-3 py-2 text-[11px] text-muted backdrop-blur">
        <div className="mb-1 font-semibold text-text">Legend</div>
        <div className="flex items-center gap-3">
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-go" />green</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-slow" />clearing</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-stop" />red</span>
        </div>
        <div className="mt-1 flex items-center gap-3">
          <span><i className="mr-1 inline-block h-2 w-3 rounded bg-free" />0-4 queued</span>
          <span><i className="mr-1 inline-block h-2 w-3 rounded" style={{ background: '#F97316' }} />5-11</span>
          <span><i className="mr-1 inline-block h-2 w-3 rounded" style={{ background: '#DC2626' }} />12+</span>
        </div>
        <div className="mt-1">Numbers beside each lamp are vehicles waiting on that approach.</div>
      </div>
    </div>
  );
}
