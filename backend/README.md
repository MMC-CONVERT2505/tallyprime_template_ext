# tallyprime_template_ext

**Phase 1 — Tally connectivity backbone.** A NestJS + TypeScript backend whose one
job right now is to talk to **TallyPrime's XML/HTTP server on port 9000**, pull
core data (companies, ledgers, vouchers), and return clean, typed JSON — with all
the real-world Tally quirks handled in one place.

This is the foundation the mapping engine, validation engine, and Excel generator
(later phases) build on top of. The Tally client is deliberately self-contained so
it can later be lifted into the on-site **connector agent** unchanged.

**Scope: extraction only.** This service reads data out of Tally — masters and
vouchers — and never writes to it. There is no import/create-in-Tally API and
none is planned; every action a connector can be asked to perform
(`src/tunnel/tunnel-protocol.ts`'s `TUNNEL_ACTIONS`) is a Tally export/report
request.

---

## Table of contents

- [Architecture & where this fits](#architecture--where-this-fits)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Enabling Tally as a server](#enabling-tally-as-a-server)
- [API reference](#api-reference)
- [Tally edge cases handled](#tally-edge-cases-handled-the-important-part)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Testing](#testing)
- [Roadmap](#roadmap)

---

## Architecture & where this fits

```
 ┌────────────────────┐        XML / HTTP           ┌──────────────────────────────┐
 │  TallyPrime        │  ◀── POST :9000 (ENVELOPE) ─│  THIS BACKEND (NestJS)        │
 │  (client desktop)  │  ──▶ XML response ─────────▶│                              │
 └────────────────────┘                             │  TallyModule                 │
                                                     │   ├─ EnvelopeBuilder (req)   │
                                                     │   ├─ TallyHttpClient (:9000) │
                                                     │   ├─ ResponseParser (quirks) │
                                                     │   └─ Master/Transaction/     │
                                                     │      Diagnostics extraction  │
                                                     │      services (+ audit)      │
                                                     │  Postgres  ── jobs/conns     │
                                                     │  Redis     ── cache/health   │
                                                     └──────────────────────────────┘
```

In production, Tally cannot be reached from the cloud (it is a LAN-only desktop
app). A small **connector agent** will eventually run on the client machine and
proxy these same requests over an outbound connection. For Phase 1, the backend
talks to Tally directly via `TALLY_HOST` / `TALLY_PORT`.

## Tech stack

| Concern            | Choice                                   |
| ------------------ | ---------------------------------------- |
| Framework          | NestJS 11 (TypeScript, strict null)      |
| Tally transport    | `@nestjs/axios` + `iconv-lite` (charset) |
| XML parsing        | `fast-xml-parser`                        |
| Identity/job state | PostgreSQL via Prisma                    |
| Auth               | Email/password, `@nestjs/jwt` + `argon2` (self-hosted, no external IdP) |
| Job queue          | BullMQ (Redis-backed)                    |
| Cache / health     | Redis via `ioredis`                      |
| Notifications       | Nodemailer                              |
| Validation         | `class-validator` + `joi` (env)          |
| Health checks      | `@nestjs/terminus`                       |

- **Full walkthrough**: [docs/connector-bridge-setup-guide.md](docs/connector-bridge-setup-guide.md) — backend + Connector Bridge (agent) + Tally, in order, with troubleshooting. This README's Quick Start below is the condensed direct-mode version (no bridge/pairing).
- **Postman collection**: [postman/](postman/) — the full API pre-wired for end-to-end runs (register → pair → extract → result, variables auto-chained between requests).
- **Web console**: [frontend/](frontend/) — a simple React app covering the same flow as a clickable UI (`cd frontend && npm install && npm run dev`).

## Prerequisites

- **Node.js ≥ 20** (developed on 24)
- **Docker + Docker Compose** (for local Postgres + Redis)
- A reachable **TallyPrime** with the HTTP server enabled — see
  [below](#enabling-tally-as-a-server). Not required just to boot the app; the
  Tally endpoints return an actionable error until Tally is reachable.

## Quick start

```bash
# 1. Configure
cp .env.example .env          # then edit if needed (see Configuration)

# 2. Start infra (Postgres + Redis)
docker compose up -d

# 3. Install & run
npm install
npm run start:dev             # watch mode on http://localhost:3000/api

# 4. Confirm it's alive (infra health)
curl http://localhost:3000/api/health

# 5. Point at Tally and probe connectivity
curl http://localhost:3000/api/tally/probe
```

> **Port conflict?** If `5432`/`6379` are already taken on your machine (e.g. by
> another project's Postgres/Redis), set `DB_PORT` / `REDIS_PORT` in `.env` to
> free ports (e.g. `5433` / `6380`). Compose publishes on those and the app
> connects to them — both read the same `.env`.

## Enabling Tally as a server

On the machine running TallyPrime, with the target **company loaded**:

1. Gateway of Tally → **F1 (Help) → Settings → Connectivity**.
2. Enable **"Act as Server"** (a.k.a. Tally.NET / ODBC-HTTP server).
3. Confirm the port is **9000** (default).

Then set `TALLY_HOST` to that machine's IP (or `127.0.0.1` if it's the same box)
and `TALLY_PORT` to `9000`. `connection refused` from `/api/tally/probe` almost
always means Tally is closed or "Act as Server" is off — the single most common
gotcha.

## API reference

All routes are under the `/api` prefix.

| Method | Path                  | Purpose                                                          |
| ------ | --------------------- | --------------------------------------------------------------- |
| GET    | `/health`             | Infra liveness (Postgres + Redis). Use for container probes.    |
| GET    | `/health/tally`       | Tally reachability, **separate** so a closed Tally ≠ app down.   |
| POST   | `/auth/register`      | Creates a new Org + its first User. No separate invite/join flow yet. |
| POST   | `/auth/login`         | Email/password login, returns a JWT.                             |
| GET    | `/auth/me`            | Returns the decoded token payload — requires `Authorization: Bearer <token>`. |
| GET    | `/tally/probe`        | Connectivity + discovery: lists open companies + round-trip ms. |
| GET    | `/tally/companies`    | All companies loaded in Tally (short-cached; `?fresh=true`).     |
| GET    | `/tally/ledgers`      | Lean ledger master (Name, Parent, Opening/Closing, AlterID); `fromDate`/`toDate` scope the balances to a period. |
| GET    | `/tally/stock-items`  | Lean stock item master (Name, Parent, BaseUnits, Opening/Closing balance+value, AlterID); `fromDate`/`toDate` scope the balances to a period. |
| GET    | `/tally/groups`       | Group master (Name, Parent, AlterID) — resolves ledger/stock-item hierarchy. |
| GET    | `/tally/vouchers`     | Vouchers for a date range, optional voucher-type filter.        |
| POST   | `/tally/raw`          | Escape hatch: request any Tally report by name, get raw XML.     |
| POST   | `/connections`        | Mints a new agent pairing token directly (shown once) — for scripted/enterprise rollout; see `/connections/device/*` for the default zero-manual-token flow. |
| GET    | `/connections`        | Lists the org's paired connectors + live connected status.       |
| POST   | `/connections/:id/revoke` | Revokes a connector and disconnects its live session if one's open. |
| POST   | `/connections/:id/rotate-token` | Mints a fresh token for the *same* connection (lost/rotating credential) instead of pairing a new one — use this, not `POST /connections`, when re-connecting an already-paired device. |
| POST   | `/connections/device/start` | No auth (the bridge has none yet). Called automatically by the bridge on first boot — returns a `deviceCode`/`userCode` pair. Device-flow pairing; see [connector-bridge-setup-guide.md](docs/connector-bridge-setup-guide.md). |
| POST   | `/connections/device/approve` | The one human step: a signed-in user approves the `userCode` the bridge printed, optionally setting `label`/`defaultCompany`. |
| POST   | `/connections/device/token` | No auth. Polled automatically by the bridge until approved; then mints the real connection + token and marks the code consumed. |
| POST   | `/extractions`        | Queues an async extraction job against a connected agent (raw `connectionId` + `type`). Phase 4. |
| POST   | `/extractions/fetch-master` | Same as above, but resolves the connector by `companyName` (no `connectionId` needed) and accepts an ISO `fromDate`/`toDate` for period-scoped master balances. |
| GET    | `/extractions/:id`    | Job status (PENDING/SUCCESS/FAILED) + metadata.                  |
| GET    | `/extractions/:id/result` | The extracted data, while SUCCESS and within the result TTL.  |
| GET    | `/extractions/:id/excel` | Zoho-import-ready Excel for job types with a mapper (STOCK_ITEMS, LEDGERS — the latter needs `?groupsJobId=`). |

### Examples

```bash
# Discover exact company names (needed for every scoped call)
curl http://localhost:3000/api/tally/probe

# Ledger masters for a company (falls back to TALLY_DEFAULT_COMPANY if omitted)
curl "http://localhost:3000/api/tally/ledgers?company=ABC%20Traders"

# Sales vouchers for April 2025 (dates are YYYYMMDD)
curl "http://localhost:3000/api/tally/vouchers?company=ABC%20Traders&from=20250401&to=20250430&voucherType=Sales"

# Arbitrary report (exploration/onboarding)
curl -X POST http://localhost:3000/api/tally/raw \
  -H 'Content-Type: application/json' \
  -d '{"reportName":"Trial Balance","company":"ABC Traders"}'
```

Every error comes back in one shape, and Tally failures carry a `hint`:

```json
{
  "statusCode": 502,
  "error": "TallyError",
  "message": "Could not reach Tally at http://127.0.0.1:9000.",
  "hint": "Confirm TallyPrime is open ... enable \"Act as Server\" ...",
  "path": "/api/tally/probe",
  "timestamp": "2026-07-25T08:38:30.524Z"
}
```

## Tally edge cases handled (the important part)

These are the things that silently break naive Tally integrations. All are
handled centrally in [`src/tally/xml`](src/tally/xml) and covered by unit tests.

| Quirk                                    | Handling                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| **Connection refused / timeout**         | Typed `TallyUnreachable`/`TallyTimeout` exceptions → 502/504 with a fix hint.   |
| **Empty `<ENVELOPE></ENVELOPE>`**        | Treated as **zero records**, not an error.                                     |
| **Non-Tally response on the port**       | Rejected (an HTML error page/plain text would otherwise parse into junk).      |
| **Single vs. array**                     | `toArray()` — Tally sends one object for 1 record, an array for many.          |
| **Omitted empty tags**                   | Every field read defensively; missing ⇒ `null`, never a crash.                 |
| **Signed amounts + `ISDEEMEDPOSITIVE`**  | Dr/Cr resolved from the flag **and** sign, not a naive "negative = credit".     |
| **Indian-grouped numbers** (`1,18,000`)  | Parsed correctly to `118000`.                                                  |
| **Non-standard `&` escaping** (`R&D`)    | Sanitized before parsing; valid entities left untouched.                       |
| **Charset** (win-1252 / ISO-8859-1)      | Response decoded via `iconv-lite`; override with `TALLY_RESPONSE_ENCODING`.     |
| **`<LINEERROR>` returned with HTTP 200** | Detected and surfaced as a `TallyResponseException` (422).                      |
| **XML injection via names** (`AT&T`)     | All request values XML-escaped in the envelope builder.                        |
| **Literal `&#4; ` prefix on built-in group refs** | Tally sends this as raw text (not a real, decodable numeric character reference) on PARENT fields pointing at top-level groups like "Primary". Stripped in `readText()`. |

## Project structure

```
src/
├── main.ts                     # bootstrap: global prefix, validation, shutdown hooks
├── app.module.ts               # wires config + DB + Redis + Tally + Health
├── config/                     # typed configuration + joi env validation
├── common/                     # global exception filter + logging interceptor
├── database/
│   ├── entities/               # TallyConnection (registry) + ExtractionJob (audit)
│   └── database.module.ts      # Prisma setup
├── redis/redis.module.ts       # global ioredis provider + graceful shutdown
├── health/                     # /health (infra) + /health/tally, custom indicators
└── tally/                      # ★ the connectivity core (read-only: extracts, never writes)
    ├── tally-http.client.ts    # POST to :9000, charset decode, retry w/ backoff, error mapping
    ├── tally-connector.interface.ts # TallyConnector — the transport boundary extraction services depend on
    ├── tally-diagnostics.service.ts # probe() + getRaw() escape hatch (not master/transaction extraction)
    ├── xml/
    │   ├── envelope.builder.ts # builds request XML (report + collection styles)
    │   ├── response.parser.ts  # parses + normalizes; all quirk-handling here
    │   └── xml.utils.ts        # pure helpers (escaping, amounts, toArray, ...)
    ├── extraction/
    │   ├── tally-extraction.base.ts        # shared audit/cache/company-resolution plumbing
    │   ├── master-extraction.service.ts    # Companies/Ledgers/Groups/Stock Items
    │   └── transaction-extraction.service.ts # Vouchers (date-ranged, optional type filter)
    ├── tally.controller.ts     # HTTP endpoints
    ├── dto/                    # validated request DTOs
    ├── interfaces/             # clean domain types (Company/Ledger/Voucher)
    └── exceptions/             # typed, hint-carrying Tally exceptions
```

## Configuration

See [`.env.example`](.env.example) for the full annotated list. Key variables:

| Variable                  | Default          | Notes                                                        |
| ------------------------- | ---------------- | ------------------------------------------------------------ |
| `TALLY_HOST` / `TALLY_PORT` | `127.0.0.1:9000` | Where Tally's HTTP server listens.                         |
| `TALLY_TIMEOUT_MS`        | `60000`          | Prefer chunking by month over raising this too high.         |
| `TALLY_RESPONSE_ENCODING` | `auto`           | Force `win1252`/`latin1` if you see mangled `£`/`é`.         |
| `TALLY_DEFAULT_COMPANY`   | *(empty)*        | Used when a request omits `company`.                         |
| `TALLY_MAX_RETRIES`       | `2`              | Extra attempts on transient failures (timeout/unreachable), exponential backoff. `0` disables. |
| `TALLY_RETRY_BASE_MS`     | `500`            | Backoff base — `500ms → 1000ms → 2000ms, ...`.               |
| `DB_*`                    | localhost/tally  | Postgres. `DB_SYNCHRONIZE=true` for dev only.                |
| `REDIS_*`                 | localhost:6379   | Cache + health (later: queue + socket adapter).              |

Env is validated at boot (joi); a missing/invalid variable fails fast with a
readable message rather than a cryptic mid-request crash.

## Testing

```bash
npm test            # unit tests (no live Tally needed)
npm run test:cov    # with coverage
```

The parser/builder tests encode real Tally response shapes (single-vs-array,
nested ledger/inventory entries, malformed `&`, omitted tags, `LINEERROR`,
empty envelopes), so regressions in quirk-handling are caught without a Tally
instance.

## Roadmap

Phase 1 (this repo) proves the connectivity backbone. Next:

- **AlterID incremental sync** — pull only changed records (highest-leverage).
- **Connector agent** — package the Tally client as an unattended Windows service.
- **Mapping engine** — config-driven Tally → destination-tool (Zoho/Xero/…) translation.
- **Validation engine** — balance/continuity/mapping-completeness checks (annotate, never block).
- **Excel generation** — write the destination tool's exact import template.
```
