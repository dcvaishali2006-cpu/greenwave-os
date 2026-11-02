# @greenwave/api

Express + WebSocket API around `@greenwave/engine`. A simulation runs continuously behind it; the dashboard reads it over REST and WebSocket.

```bash
cp ../../.env.example ../../.env     # optional: defaults work for development
npm run dev -w @greenwave/api        # from the repo root; API on http://localhost:4000
npm test -w @greenwave/api           # 42 tests (43 with PostgreSQL): auth, RBAC, audit, Why?, scenarios, compare, WebSocket, emergency, Time Machine, Copilot, database
```

Set `SIM_SPEED=10` to fast-forward the simulation (10 simulated seconds per real second) when demoing.

Demo accounts (password `demo1234`): `admin@demo.com`, `operator@demo.com`, `viewer@demo.com`.

## Endpoints (`/api/v1`)

| Method and path | Role | What it does |
| --- | --- | --- |
| `GET /health` | public | Liveness check |
| `POST /auth/login` | public | `{email, password}` returns access token (15 min), refresh token (7 days), user. Rate limited |
| `POST /auth/refresh` | public | `{refreshToken}` returns a new access token |
| `GET /auth/me` | any | Current user |
| `GET /junctions` | any | Live network: phase, countdown, queue, due vehicles per approach |
| `GET /junctions/:id` | any | One junction plus its last decision |
| `GET /junctions/:id/why?limit=5` | any | The Why? button: recent signal decisions with plain-English reasons |
| `GET /live/status` | any | Scenario, controller, simulated time, running metrics |
| `GET /live/plan-changes` | any | Recent adaptive plan changes with reasons |
| `POST /live/controller` | operator, admin | `{controller: 'fixed' \| 'fixed-tuned' \| 'adaptive'}` swaps strategy mid-run |
| `POST /live/scenario` | operator, admin | `{scenario, seed?, controller?}` starts a scenario (`normal`, `incident`, `rain`) |
| `GET /live/emergency` | any | Signal priority on or off, and the ambulance trips so far |
| `POST /live/emergency` | operator, admin | `{direction: 'EB' \| 'WB'}` sends an ambulance (EB = J1 to the last junction, WB = the reverse). Audited |
| `POST /live/emergency/priority` | operator, admin | `{enabled: boolean}` signal priority for ambulances. Audited |
| `GET /analytics/emergency?scenario=&controller=&seeds=` | any | Measured ambulance benefit and cost to other traffic, priority off vs on (cached) |
| `GET /timemachine/fork?scenario=&seed=&at=&window=&history=&seeds=` | any | Time Machine: fork at second `at`, compare fixed, fixed-tuned and adaptive for `window` seconds on identical traffic, plus the same fork over `seeds` seeds. Read-only (the live run is untouched), cached, 30 per minute |
| `GET /copilot/status` | any | Which brain answers: `built-in` or `claude` (when `ANTHROPIC_API_KEY` is set) |
| `POST /copilot/ask` | any | `{message}` (1-500 chars, 30 per minute). Answers from live data. Any action comes back as a **proposal**, never executed |
| `POST /copilot/proposals/:id/approve` | operator, admin | Runs the proposed action through the same live methods as the buttons. Expires after 10 min; 409 if already decided. Audited as `copilot_approve` |
| `POST /copilot/proposals/:id/reject` | operator, admin | Rejects a proposal. Audited as `copilot_reject` |
| `GET /analytics/compare?scenario=&seeds=` | any | Adaptive vs fixed benchmark over 1 to 10 seeds (cached) |
| `GET /admin/audit?action=&user=&limit=` | admin | Audit log |
| `GET /admin/users` | admin | Users (no password hashes) |
| `POST /admin/users` | admin | `{email, name, role, password (8+ chars)}` creates a user. 409 if the email exists. Audited as `create_user` |

Errors always look like `{ "error": { "code": "FORBIDDEN", "message": "..." } }`.

## WebSocket: `/ws?token=<access token>`

A bad token closes with code 4401. Server messages:

| Message | When |
| --- | --- |
| `{type:'hello', status}` | on connect |
| `{type:'tick', state}` | every simulated second: all junctions |
| `{type:'decision', decision}` | each new signal decision with its reason |
| `{type:'run', ...status}` | controller switched, or a scenario started or restarted |

Client messages: `{type:'subscribe', junctionIds:['J1','J3']}` limits tick payloads, `{type:'ping'}`.

## What is real and what is a stand-in

- **Real:** JWT auth, refresh tokens, role checks in one middleware, audit of logins, denied attempts and control actions, input validation, rate-limited login, security headers.
- **Stand-in:** users and the audit log live in memory (a restart clears them). Swap `AuthService.users` and `AuditLog` for the `users` and `audit_logs` tables from the build guide when PostgreSQL is wired in.
- **Not built yet:** incidents and diversions, the agent role, and `POST /runs/:id/fork` (the engine already supports forks via `setController`).

## Database

Users and the audit log are saved; everything else is rebuilt from the simulator's seed.

| Setting | Result |
|---|---|
| nothing set | SQLite file at `apps/api/data/greenwave.db` (created on first start, ignored by git) |
| `DB_PATH=...` | SQLite file somewhere else |
| `DATABASE_URL=postgres://...` | PostgreSQL (hosting). Tables are created on first start. A wrong URL stops the server with an error |
| `DB=memory` | nothing saved (what the tests use) |

`GET /health` shows which one is active. The first start saves the three demo accounts; after that the saved users are used. Delete the `.db` file to reset. If the SQLite module cannot load, the API warns and runs without saving instead of failing.

PostgreSQL test: `TEST_DATABASE_URL=postgres://user@localhost:5432/emptydb npm test -w @greenwave/api` (skipped when not set).
