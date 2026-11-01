# @greenwave/web

Control Room for GreenWave OS. Next.js 14 (app router), Tailwind 3, Leaflet.

## Run

```bash
cp .env.example .env.local     # NEXT_PUBLIC_API_URL=http://localhost:4000
npm run dev                    # http://localhost:3000
npm run build && npm start     # production
```

The API must be running (`npm run dev -w @greenwave/api` from the repo root).

## Screens

- **Map**: five junctions with lamp colours and queue counts per approach; roads turn orange/red as queues grow. Click a junction for details.
- **KPIs**: average wait, average queue, throughput, idling CO2 for the current run.
- **Compare**: adaptive vs fixed over 5 seeded runs of the current scenario, with a finding that says when adaptive only ties or loses.
- **Why the signals changed**: live feed of decisions; the junction panel shows the latest reasons for that junction.
- **Top bar**: controller switch and scenario select (disabled for viewers).

## Notes

- Access token is kept in memory, refresh token in `sessionStorage`; one automatic refresh retry on 401.
- Live data comes over WebSocket (`/ws?token=`) with backoff, plus a 2 s status poll as fallback.
- Junction coordinates in `lib/corridor.ts` are placeholders; replace them with your real corridor.
- Leaflet is loaded with `dynamic(..., { ssr: false })`; engine types are imported type-only.
