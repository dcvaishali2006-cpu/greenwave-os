# GreenWave OS

An explainable, replayable traffic-signal control room for an urban corridor (Hack Vally 2026, Track 02, PS1).

Five junctions run on a deterministic, seeded simulator. You can watch them live, switch between a fixed-time plan and an adaptive controller, change the scenario, and ask any junction **"Why did the signal change?"**

## Quick start

```bash
npm install
cp .env.example .env                      # optional; defaults work

# Terminal 1: API on http://localhost:4000
npm run dev -w @greenwave/api

# Terminal 2: Control Room on http://localhost:3000
cp apps/web/.env.example apps/web/.env.local
npm run dev -w @greenwave/web
```

Demo accounts are shown as buttons on the login screen (admin, operator, viewer). Viewers can watch but cannot change the controller or scenario.

Tests:

```bash
npm test -w @greenwave/engine     # simulator, controllers, emergency corridor, Time Machine (30 tests)
npm test -w @greenwave/api        # auth, roles, endpoints, emergency, Time Machine, Copilot (42 tests)
npm run benchmark -w @greenwave/engine -- --seeds=1..10
```

## Structure

| Path | What it is |
|---|---|
| `packages/engine` | Seeded simulator, fixed-time and adaptive (Webster-based) controllers, benchmark |
| `apps/api` | Express + WebSocket API, JWT auth, roles, saved audit log (SQLite or PostgreSQL). See `apps/api/README.md` |
| `apps/web` | Next.js Control Room: live map, KPIs, decision feed, Why? panel, comparison |

## What makes it different

- **Why?** Every signal change and plan change is logged with a plain-language reason.
- **Fair comparison.** Each seed produces identical entry traffic for every controller, so differences come from the controller alone.
- **Emergency corridor.** Send an ambulance and the signals ahead of it turn green in time: trip time falls from about 160 s to about 92 s with no stops, and the app shows what that costs everyone else.
- **Time Machine.** Rewind to any moment, switch the signal controller from there, and compare on identical traffic. It says "no clear difference" when that is the truth.
- **Traffic Copilot.** Ask in plain words ("Why is J3 backing up?", "What should I do?"). It answers from live data and can only *propose* actions; an operator must approve, and every approval is audited. Works offline with a built-in assistant; set `ANTHROPIC_API_KEY` to let Claude answer instead (falls back to built-in on any failure).
- **Honest results.** The controller was tuned on seeds 101-110 and is reported on seeds 1-10. See `packages/engine/README.md` for the numbers, including where adaptive only ties the fixed plan.

## Status and limits

Built and tested: simulator, controllers, API, Control Room (checked in a real browser).

Database: users and the audit log are saved (SQLite file on a laptop, PostgreSQL when `DATABASE_URL` is set), so they survive restarts. The live simulation itself is not stored; it restarts from its seed.

Not built yet: incidents with diversions, MCP server, deployment.

Model limits: two signal phases, no turning movements, no platoon dispersion. Results are from a simulator, not real roads.

## Use your real corridor

Junction coordinates are in `apps/web/lib/corridor.ts` (currently a stretch of road in Belagavi). To use another road, replace the `lat`/`lng` of J1-J5 with your five junctions in order along the road. The map fits itself to them.

Map tiles (OpenStreetMap, darkened with CSS) load from the internet; offline you get a plain dark background and everything else still works.
