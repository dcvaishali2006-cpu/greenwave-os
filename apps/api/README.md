# @greenwave/api

Express + WebSocket API around `@greenwave/engine`. A simulation runs continuously behind it; the dashboard reads it over REST and WebSocket.

```bash
cp ../../.env.example ../../.env     # optional: defaults work for development
npm run dev -w @greenwave/api        # from the repo root; API on http://localhost:4000
npm test -w @greenwave/api           # 14 tests: auth, RBAC, audit, Why?, scenarios, compare, WebSocket
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
| `GET /analytics/compare?scenario=&seeds=` | any | Adaptive vs fixed benchmark over 1 to 10 seeds (cached) |
| `GET /admin/audit?action=&user=&limit=` | admin | Audit log |
| `GET /admin/users` | admin | Users (no password hashes) |

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
- **Not built yet:** incidents and diversions, emergency corridor, copilot and proposals, the agent role, and `POST /runs/:id/fork` (the engine already supports forks via `setController`).
