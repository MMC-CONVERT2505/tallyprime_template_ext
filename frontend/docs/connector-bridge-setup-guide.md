# Tally Connector Bridge — Setup & Data Extraction

A from-scratch guide to getting a working chain — **Tally → Connector Bridge → Backend → API response** — and pulling your first real extraction. Companion to [architecture.md](architecture.md) (the *why*) and the main [README.md](../README.md) (the day-to-day API reference); this doc is the *do these exact steps in this exact order* version.

Every command and config value below is taken directly from this repo's own config/DTOs — file references are given throughout so you can verify against the source rather than trust this doc blindly.

Prefer clicking over `curl`? [postman/](../postman/) has the whole flow below as a ready-to-import Postman collection, with each response's values auto-chained into the next request.

---

## Contents

- [Prerequisites](#prerequisites)
- [1. Start the backend server](#1-start-the-backend-server)
- [2. Set up the Connector Bridge (the agent)](#2-set-up-the-connector-bridge-the-agent)
- [3. Configure Tally](#3-configure-tally)
- [4. Extract data from Tally](#4-extract-data-from-tally)
- [5. Recommended startup sequence](#5-recommended-startup-sequence)
- [6. Troubleshooting](#6-troubleshooting)
- [Quick Start checklist](#quick-start-checklist)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 20** | `node -v`. Developed on Node 24. |
| **Docker + Docker Compose** | For local Postgres + Redis (`docker-compose.yml`, repo root). Not required if you point `DB_*`/`REDIS_*` at instances you already run elsewhere. |
| **TallyPrime**, installed and licensed | The connector talks to Tally's own HTTP/XML server — no separate Tally SDK. |
| **A machine that can reach Tally on its configured port (default 9000)** | In local dev this is usually the same machine. In a real deployment this is whichever machine runs the Connector Bridge — it must be on the same LAN as Tally, or the same machine. |
| `git`, a shell (bash/PowerShell) | For cloning and running npm scripts. |

Two deployment shapes exist, both covered below:

- **Direct mode (fastest, single machine, dev-only)** — the backend's own `/api/tally/*` endpoints talk to Tally directly (`TALLY_HOST`/`TALLY_PORT`). No bridge, no pairing, no queue. Good for a first smoke test.
- **Bridge mode (the real architecture)** — the backend never talks to Tally directly. A separate **Connector Bridge** process (`npm run start:agent` / the packaged connector exe) runs on the machine that *can* reach Tally, connects **outbound** to the backend over a WebSocket tunnel, and executes extraction commands the backend queues for it. This is what lets the backend live in the cloud while Tally stays on a client's desk. See [architecture.md](architecture.md) for why (NAT/firewall: Tally's machine can't accept inbound connections from the internet, so the bridge must dial out).

---

## 1. Start the backend server

### 1.1 Environment variables

Copy the template and fill in what's marked required:

```bash
cp .env.example .env
```

Everything is documented inline in [`.env.example`](../.env.example); the schema that actually validates it at boot is [`src/config/env.validation.ts`](../src/config/env.validation.ts). The only variable with **no default** — the app refuses to boot without it:

```bash
# JWT_SECRET — required, min 32 chars, no default (a shared fallback would mean
# every install that forgets to set it shares the same forgeable signing key).
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste that output into `.env` as `JWT_SECRET=...`.

Everything else has a sane local-dev default (see [`src/config/configuration.ts`](../src/config/configuration.ts) for exactly what each one resolves to):

| Variable | Default | Matters for |
|---|---|---|
| `PORT` | `3000` | Where the backend listens. |
| `APP_GLOBAL_PREFIX` | `api` | Every route is under `/api/...`. |
| `TALLY_HOST` / `TALLY_PORT` | `127.0.0.1:9000` | Only used by the backend's **direct** `/tally/*` endpoints (§ Direct mode) and by the Connector Bridge (which has its own, separate env — see §2). |
| `TALLY_MAX_RETRIES` / `TALLY_RETRY_BASE_MS` | `2` / `500` | Retries transient Tally failures (timeout/unreachable) with exponential backoff before giving up. |
| `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` or `DATABASE_URL` | `127.0.0.1:5432`, `tally`/`tally`/`tally_migration` | Postgres — orgs/users, paired connectors, extraction-job audit trail. |
| `REDIS_HOST`/`REDIS_PORT` | `127.0.0.1:6379` | Cache, BullMQ job queue, extraction-result short-TTL storage. |
| `EXTRACTION_RESULT_TTL_SECONDS` | `3600` | How long a completed job's data stays fetchable. |
| `SMTP_*` | *(unset)* | Optional — job-complete emails. Leave `SMTP_HOST` empty to skip entirely; nothing else breaks. |

### 1.2 Install dependencies

```bash
npm install
```

`postinstall` runs `prisma generate` automatically (see `package.json`), so the Prisma client is ready immediately after.

### 1.3 Start Postgres + Redis

```bash
docker compose up -d
```

This starts **only** Postgres + Redis (the `app` service is behind a `--profile full` flag you don't need for dev — see [`docker-compose.yml`](../docker-compose.yml)). Ports published are `${DB_PORT:-5432}` and `${REDIS_PORT:-6379}`; if either is already taken on your machine, set `DB_PORT`/`REDIS_PORT` in `.env` to a free port before this step — both `.env` and this compose file read the same variables.

### 1.4 Apply database migrations

```bash
npm run prisma:migrate:deploy
```

This applies every migration already committed under `prisma/migrations/` (no interactive prompts — that's `prisma migrate dev`, meant for authoring *new* migrations, not for first-time setup).

### 1.5 Start the server

```bash
npm run start:dev
```

(`start:dev` = watch mode; use `npm run start` for a one-shot run, or `npm run build && npm run start:prod` for the production build.)

### 1.6 Verify the server is running

```bash
curl http://localhost:3000/api/health
```

Expect an `{"status":"ok", ...}`-shaped Terminus response. This only checks Postgres + Redis — deliberately **not** Tally (see [`src/health/tally.health.ts`](../src/health/tally.health.ts): a closed Tally is a normal, frequent state and must not make the whole service report unhealthy). The server also logs its listening address on boot:

```
API listening on http://localhost:3000/api
Configured Tally endpoint: http://127.0.0.1:9000
Probe connectivity: GET http://localhost:3000/api/tally/probe
```

> The server will still boot with Postgres/Redis unreachable (`StartupHealthService` logs a warning and continues in "degraded mode" — see [`src/common/services/startup-health.service.ts`](../src/common/services/startup-health.service.ts)). `/api/health` and `/api/tally/probe` still work in that state; anything touching auth/connections/extractions won't.

---

## 2. Set up the Connector Bridge (the agent)

The bridge is the same codebase, run as a different entry point (`agent-main.ts` instead of `main.ts`) — no HTTP server, no controllers, just the Tally extraction stack plus an outbound WebSocket client (`src/agent/`). It never accepts inbound connections.

**No manual token to copy.** Leave `AGENT_TOKEN` unset and the bridge pairs itself automatically on first boot — this is the default, recommended path (§2.1). A manual/scripted alternative exists for bulk enterprise rollouts where no human is at the console (§2.4).

### 2.1 Start the bridge with no token configured

```bash
npm run start:agent
```

(This runs `dist/agent-main.js`, so `npm run build` first if you haven't. For a real client-machine install, `npm run package:win` produces a standalone `dist-exe/tally-backend.exe` — same behavior.)

With no `AGENT_TOKEN` in its `.env`, `AgentTunnelClient` runs `AgentPairingService.pair()` automatically instead of connecting directly ([`src/agent/agent-pairing.service.ts`](../src/agent/agent-pairing.service.ts)) — a Device Authorization Grant (RFC 8628-style; see [architecture.md](architecture.md) for the full design rationale). Its logs print something like:

```
This connector is not yet paired to an organization.
1. Sign in to the web app.
2. Approve this device with code:  WXYZ-2H4K
   (POST http://127.0.0.1:3000/api/connections/device/approve
    { "userCode": "WXYZ-2H4K", "defaultCompany": "<exact Tally company>" }
    while signed in)
Waiting up to 10 minute(s) for approval...
```

### 2.2 Approve it — the one unavoidable human step

Some form of human authorization is unavoidable here: nothing should be able to silently attach to your org's Tally data without one. This is the smallest version of that decision — typing a short code, not copying a 100-character secret. From any machine, signed in:

```bash
# If you don't already have a JWT: register or log in first
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
TOKEN="<accessToken from above>"

# Approve the code shown in the bridge's logs
curl -X POST http://localhost:3000/api/connections/device/approve \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"userCode":"WXYZ-2H4K","label":"Accounts PC","defaultCompany":"ABC Traders"}'
# -> { "approved": true }
```

`defaultCompany` (optional, but strongly recommended) is the **exact** company name as it appears in Tally — this is what pins the connector to one company so a request can never silently be served against the wrong one (`ExtractionsService.resolveCompany`, [`src/extractions/extractions.service.ts`](../src/extractions/extractions.service.ts)). See [`src/connections/dto/approve-device.dto.ts`](../src/connections/dto/approve-device.dto.ts) for the exact request shape. (There's no web UI for this yet — Phase 8 in [architecture.md](architecture.md) — so `curl`/Postman is today's "approve" screen, same as every other endpoint in this API-only phase.)

### 2.3 It finishes automatically

The bridge is already polling (every few seconds, per the `interval` it was told at start). Within one poll after you approve, it:
1. receives the real device token,
2. **writes `AGENT_TOKEN` into its own `.env` itself** — no human edits a config file —
3. connects to the gateway with it.

```
Paired successfully — connection id 0bd3e911-... ("Accounts PC").
Saved AGENT_TOKEN to /path/to/.env for future restarts.
Connecting to gateway at ws://127.0.0.1:3000/agent-tunnel...
Authenticated. Agent id: 0bd3e911-...
```

From here on, restarts skip pairing entirely — `AGENT_TOKEN` is now in `.env`, same as the manual flow below, just nobody typed it. Confirm from the backend side, scoped to your org:

```bash
curl http://localhost:3000/api/connections -H "Authorization: Bearer $TOKEN"
# -> [{ "id": "...", "label": "Accounts PC", "connected": true, ... }]
```

**Re-authentication after revocation:** if this connection is later revoked (`POST /connections/:id/revoke`), the gateway sends `auth-error` on the bridge's next connect attempt. The bridge clears its now-dead token in memory and automatically re-runs pairing (§2.1) on its next reconnect — no manual intervention, no restart needed. See `AgentTunnelClient.handleMessage`'s `auth-error` branch.

> **A gap worth knowing about:** there is currently no standalone "ping the bridge" endpoint (an earlier proof-of-concept one, `GatewayController`, was removed for being unscoped by org — any authenticated user could drive *any* org's agent through it; see [architecture.md](architecture.md)'s Security non-negotiables). `connected: true` proves the tunnel is up, but not that the bridge can reach Tally — for that, run the cheap extraction test in §4.3.

### 2.4 Alternative: pre-provisioned token (scripted/enterprise rollout)

For pushing installs to many machines with no human at the console (SCCM/Ansible/Intune), mint the token ahead of time and inject it via your deployment tooling's own secrets mechanism instead of running the interactive flow:

```bash
curl -X POST http://localhost:3000/api/connections \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"Client XYZ - Accounts PC","defaultCompany":"ABC Traders"}'
# -> { "id": "...", "label": "...", "token": "<id>.<secret>" }
```

Copy the `token` value — you cannot fetch it again (only its hash is stored, per [`src/connections/connections.service.ts`](../src/connections/connections.service.ts)). Set it as `AGENT_TOKEN` in that machine's `.env` before first boot; §2.1's pairing flow only runs when `AGENT_TOKEN` is absent, so a pre-set value skips it entirely.

> **Pair each physical device/install exactly once**, by whichever path (§2.1 or §2.4). `POST /connections` always creates a **new** row — it is not idempotent. If you lose a token or want a fresh one for a device you already paired, do **not** call this again with the same label; that leaves the old row behind, still active, still paired to the same company — and a second active connection sharing a `defaultCompany` is exactly what makes `POST /extractions/fetch-master` fail with `"N connectors are paired with company ..."`. Instead, rotate the existing one:
>
> ```bash
> curl -X POST http://localhost:3000/api/connections/<existing id>/rotate-token \
>   -H "Authorization: Bearer $TOKEN"
> # -> { "id": "<same id>", "label": "...", "token": "<id>.<new secret>" }
> ```
>
> Same connection id, same `defaultCompany`, brand-new secret — the old token stops working immediately. If you already ended up with duplicates, `GET /connections` to see them and `POST /connections/:id/revoke` the extras, keeping exactly one active per company.

`GATEWAY_URL`/`API_BASE_URL` are plain HTTP(S)/WS(S) URLs, **not** under Nest's global `/api` route prefix in the gateway's case — `GATEWAY_URL` is the raw `ws` path the gateway listens on (`@WebSocketGateway({ path: '/agent-tunnel' })`, [`src/gateway/tally-tunnel.gateway.ts`](../src/gateway/tally-tunnel.gateway.ts)); `API_BASE_URL` (default `http://127.0.0.1:3000/api`) is what §2.1's pairing calls hit and already includes the prefix. For a real remote deployment these become `wss://your-backend-host/agent-tunnel` and `https://your-backend-host/api`.

The bridge also reads the same `TALLY_HOST`/`TALLY_PORT`/`TALLY_TIMEOUT_MS`/`TALLY_RESPONSE_ENCODING`/`TALLY_DEFAULT_COMPANY`/`TALLY_MAX_RETRIES`/`TALLY_RETRY_BASE_MS` variables as the backend (§1.1) — but here they describe **this machine's** view of Tally, which in a real deployment is a different machine than wherever the backend runs.

---

## 3. Configure Tally

On the machine the **bridge** runs on (not necessarily the backend's machine), with the target company already open:

1. In TallyPrime: **F1 (Help) → Settings → Connectivity**.
2. Enable **"Act as Server"** (TallyPrime's built-in HTTP/XML server — this is what the bridge/backend actually talks to; no separate plugin or API key).
3. Confirm/set the port — **9000** is the default this project assumes (`TALLY_PORT`).
4. Leave the target company **loaded** in Tally — extraction requests reference it by exact name (`TALLY_DEFAULT_COMPANY`, or an explicit `company`/`companyName` per request); Tally must have it open to answer for it.

No XML/API config on Tally's side beyond this — everything about *what* gets requested (which fields, which report) is built entirely on this project's side (`src/tally/xml/envelope.builder.ts`), not configured in Tally.

### Verify Tally is reachable from the bridge/backend

Whichever process has `TALLY_HOST`/`TALLY_PORT` pointed at this Tally instance:

```bash
curl http://localhost:3000/api/tally/probe
```

```json
{ "reachable": true, "companies": ["ABC Traders"], "durationMs": 42 }
```

This is the fastest possible check — it needs no auth, no pairing, no queue, just the backend's own `TALLY_HOST`/`TALLY_PORT` pointed at a reachable Tally. `companies` is also how you discover the **exact** name string to use everywhere else (case/spacing must match exactly). `connection refused` here almost always means "Act as Server" is off or Tally is closed — see §6.

To verify specifically *through the bridge* (not the backend's own direct connection), see §4.3 — run a real extraction and check whether it succeeds.

---

## 4. Extract data from Tally

### The data flow

```
Tally (HTTP/XML :9000)
   ↕  EnvelopeBuilder → TallyConnector → TallyResponseParser
   (this triad runs identically whether driven directly by the backend,
    or by the bridge over the tunnel — see architecture.md)
Connector Bridge (src/agent/) ──── outbound wss:// ────▶ Gateway (src/gateway/)
                                                              │
                                                     BullMQ job queue (Redis)
                                                              │
                                                  ExtractionsProcessor (src/extractions/)
                                                              │
                              Postgres: ExtractionJob row (status/audit — never raw data)
                              Redis: extraction-result:<jobId> (raw data, short TTL)
                                                              │
                                                    GET /extractions/:id/result
```

Extracted data is **never persisted** to Postgres — only job *metadata* is (type, company, status, record count, timing; see the "two decisions" in [architecture.md](architecture.md)). The actual records sit in Redis under a short TTL (`EXTRACTION_RESULT_TTL_SECONDS`) until you fetch them, then expire.

### 4.1 Direct mode (fastest — no bridge required)

If the backend itself can reach Tally (same machine/LAN, dev setup), skip pairing entirely:

```bash
curl "http://localhost:3000/api/tally/ledgers?company=ABC%20Traders"
```

Returns the mapped ledger list synchronously, no auth, no job/queue involved — this is `TallyController` → `MasterExtractionService` calling Tally directly (`src/tally/tally.controller.ts`). Good for a first sanity check, but it's **not** exercising the Connector Bridge — for that, use §4.2.

### 4.2 Bridge mode (the real flow — via a paired connector)

This is what actually goes through the bridge you set up in §2. Two ways to kick off a job:

**a) By company name** (resolves the paired connector automatically — no `connectionId` needed):

```bash
curl -X POST http://localhost:3000/api/extractions/fetch-master \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "companyName": "ABC Traders",
    "masterType": "LEDGERS",
    "fromDate": "2026-04-01",
    "toDate": "2026-04-30"
  }'
# -> 202 Accepted: { "id": "<jobId>", "status": "PENDING" }
```

`masterType` must be one of `COMPANIES` | `LEDGERS` | `STOCK_ITEMS` | `GROUPS` (`MASTER_EXTRACTABLE_TYPES`, [`src/extractions/extraction-action.map.ts`](../src/extractions/extraction-action.map.ts)). `fromDate`/`toDate` are **ISO `YYYY-MM-DD`** here specifically (converted to Tally's native `YYYYMMDD` internally) — optional, and only meaningful for `LEDGERS`/`STOCK_ITEMS` (they scope Opening/Closing balances to a period). `companyName` is how the connector gets picked in the first place — it must exactly match some connection's paired `defaultCompany` from §2.1, or the request 404s (see [`src/extractions/dto/fetch-master.dto.ts`](../src/extractions/dto/fetch-master.dto.ts) and the troubleshooting table below).

**b) By connection id directly** (if you already know it, or need a type `fetch-master` doesn't cover — e.g. `VOUCHERS`, `RAW`):

```bash
curl -X POST http://localhost:3000/api/extractions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "connectionId": "<id from GET /connections>",
    "type": "VOUCHERS",
    "payload": { "from": "20260401", "to": "20260430", "voucherType": "Sales" }
  }'
```

Note the different date format here — `/extractions`'s `payload` is passed straight through to the extraction service, which speaks Tally's native `YYYYMMDD` (see [`src/tally/dto/extract.dto.ts`](../src/tally/dto/extract.dto.ts)), unlike `/extractions/fetch-master`'s friendlier ISO dates.

### 4.3 Poll for the result

```bash
curl http://localhost:3000/api/extractions/<jobId> -H "Authorization: Bearer $TOKEN"
# -> { "id": "...", "status": "PENDING" | "SUCCESS" | "FAILED", "recordCount": ..., "error": ..., ... }
```

Once `status: "SUCCESS"`:

```bash
curl http://localhost:3000/api/extractions/<jobId>/result -H "Authorization: Bearer $TOKEN"
# -> the actual extracted records, as JSON
```

This round trip **is** the practical way to verify Bridge → Tally connectivity end-to-end (see the gap noted in §2.4) — a cheap one to use for that specifically is `masterType: "COMPANIES"` or `"GROUPS"`, since neither needs a date range.

If `status: "FAILED"`, the `error` field on the job (or the `message` in the `fetch-master`/`extractions` response body, if it failed synchronously before queueing) has the actual reason — usually one of the Tally exceptions in [`src/tally/exceptions/tally.exceptions.ts`](../src/tally/exceptions/tally.exceptions.ts), each with an actionable `hint`.

### Where extracted data ends up

- **Immediately after `GET /extractions/:id/result`**: plain JSON, in the response body — nothing else to configure.
- **Storage**: Redis only, key `extraction-result:<jobId>`, expiring after `EXTRACTION_RESULT_TTL_SECONDS` (default 1 hour). Fetch it before then, or re-run the extraction.
- **Not stored anywhere else** — Postgres only ever holds the `ExtractionJob` audit row (type/company/status/counts/timing), never the raw records (deliberate — see [architecture.md](architecture.md)).
- **Excel**: `GET /extractions/:id/excel` produces a Zoho-import-ready workbook, but only for job types with a mapper today (`STOCK_ITEMS`, and `LEDGERS` — which additionally needs `?groupsJobId=<a completed GROUPS job's id>`). Out of scope for this guide; see the README's API reference.

---

## 5. Recommended startup sequence

```text
1. Start Tally, with the target company open, "Act as Server" enabled (§3)
2. docker compose up -d                          # Postgres + Redis
3. npm run prisma:migrate:deploy                 # once, or after pulling new migrations
4. npm run start:dev                              # backend
5. curl .../api/health                            # backend is up
6. curl .../api/tally/probe                       # backend -> Tally reachable (direct mode sanity check, §3)
7. npm run start:agent                            # start the Connector Bridge, no AGENT_TOKEN set (§2.1)
8. POST /api/auth/register (or /login)            # get a JWT, from any machine
9. POST /api/connections/device/approve           # approve the code the bridge printed (§2.2) — the one human step
10. (automatic) bridge polls, gets its token, saves it, connects (§2.3)
11. GET /api/connections                          # confirm connected: true
12. POST /api/extractions/fetch-master             # run a real extraction through the bridge
13. GET /api/extractions/:id -> :id/result          # verify status SUCCESS and inspect the data
```

Steps 1–6 are a fast direct-mode sanity check and can be skipped once you trust Tally connectivity; steps 7–13 are what actually exercises the Connector Bridge end to end. Note the bridge (step 7) starts *before* you have a JWT — that's intentional, it just waits, printing its pairing code until someone approves it.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Backend won't boot: `JWT_SECRET` validation error | Missing/too-short `JWT_SECRET` | Generate one (§1.1) and set it in `.env`. No default exists on purpose. |
| Backend won't boot: other env validation errors | A required var is missing/malformed | The Joi error message lists every failing var at once (`abortEarly: false` — [`env.validation.ts`](../src/config/env.validation.ts)); fix all of them, not just the first. |
| `GET /api/health` fails / times out | Postgres or Redis unreachable | Check `docker compose ps`; confirm `DB_PORT`/`REDIS_PORT` in `.env` match what's actually published (a port conflict with another local project is the most common cause). |
| `GET /api/tally/probe` → `Could not reach Tally at http://...` (502) | Tally closed, "Act as Server" off, wrong `TALLY_HOST`/`TALLY_PORT`, or a firewall | Re-check §3. If Tally is on a different machine than whichever process is probing, confirm that machine's firewall allows inbound on `TALLY_PORT`. |
| `GET /api/tally/probe` → Gateway Timeout (504) | Tally is reachable but slow (large company / the request timed out) | Raise `TALLY_TIMEOUT_MS`, or narrow the request (date range for vouchers). Retries (`TALLY_MAX_RETRIES`) only help with transient blips, not a consistently-too-slow Tally. |
| `probe`/raw XML error mentioning `LINEERROR` | Tally answered but rejected the request (bad report name, `SVCURRENTCOMPANY` mismatch) | Check the company name is **exact** — get it from `GET /api/tally/probe`'s `companies` list, not typed from memory. |
| Bridge logs `Reconnecting in ...ms` in a loop, never `Authenticated` | Wrong `GATEWAY_URL`, or a stale/revoked `AGENT_TOKEN` from before this session's pairing changes | Wrong `GATEWAY_URL`: check §2.4. A dead token: as of this flow, an `auth-error` now clears it and auto-re-pairs (§2.3) — if you're still stuck, delete `AGENT_TOKEN` from `.env` and restart to force fresh pairing (§2.1). |
| Bridge prints a pairing code but `POST /connections/device/approve` 404s `"No pending pairing request with that code"` | Typo'd the code, or it expired (10 min window) | Re-copy the code exactly from the bridge's current logs — restarting the bridge issues a new one, the old one no longer matches. |
| `POST /connections/device/token` (what the bridge itself polls) → 400 `"already been used"` | This device code was already consumed by an earlier successful pairing | Expected once pairing succeeds — a device code is single-use. If the bridge is still trying to use an old one, restart it to get a fresh code. |
| `GET /connections` shows `connected: false` after the bridge logs `Authenticated` | The socket dropped after connecting (network blip) | The bridge auto-reconnects with backoff (`AgentTunnelClient.computeBackoffMs`, 1s → 30s ceiling) — wait, or check the bridge's own logs for a `close`/`error` event. |
| `POST /extractions` or `/extractions/fetch-master` → 400 `"This connector is not currently online."` | Bridge isn't connected right now | Confirm via `GET /connections` first; jobs are rejected immediately rather than queued to fail later. |
| `POST /extractions/fetch-master` → 404 `"No active connector is paired with company ..."` | No **active** connection in your org has that exact `defaultCompany` (revoked ones don't count) | `GET /connections` to see what's actually paired and active; company-name matching is exact (case/spacing). This endpoint resolves the connector *by* company name, so a mismatch is "not found," not "wrong company" — that check (below) only applies to `POST /extractions`. |
| `POST /extractions/fetch-master` → 400 `"N connectors are paired with company ..."` | More than one **active** connection in your org shares that `defaultCompany` — almost always from re-pairing the same device instead of rotating its token (§2.1) | The error lists the candidate `connectionId`s directly. Either use one explicitly via `POST /extractions`, or `POST /connections/:id/revoke` the stale duplicate(s) so only one active connection remains for that company — revoking actually removes it from consideration (it's excluded by `isActive`, not just hidden). |
| `POST /extractions` → 400 `"does not match this connector's paired company"` | You passed an explicit `payload.company` that differs from the target connection's `defaultCompany` | An agent can only extract from the company it's paired to (§2.1) — either drop the override, or re-pair without a `defaultCompany` if this bridge is meant to serve multiple companies. |
| Job status stays `PENDING` a long time, then `FAILED` | Tally itself failed the request (bad company, closed) after 3 retry attempts (`ExtractionsModule`'s `defaultJobOptions`) | Check the job's `error` field (`GET /extractions/:id`) — it's the underlying Tally exception's message. |
| `GET /extractions/:id/result` → 404 `"Result has expired..."` | Past `EXTRACTION_RESULT_TTL_SECONDS` since the job succeeded | Re-run the extraction; raise the TTL in `.env` if you need a longer window. |
| Port already in use (`3000`, `5432`, `6379`, `9000`) | Another local process/project | Change `PORT`/`DB_PORT`/`REDIS_PORT` in `.env` (docker-compose reads the same vars); `TALLY_PORT` must match whatever you set in Tally's own Connectivity settings. |

---

## Quick Start checklist

- [ ] `cp .env.example .env`, set `JWT_SECRET`
- [ ] `npm install`
- [ ] `docker compose up -d`
- [ ] `npm run prisma:migrate:deploy`
- [ ] `npm run start:dev` → `curl .../api/health` succeeds
- [ ] Tally: "Act as Server" on, target company open, port `9000`
- [ ] `curl .../api/tally/probe` → `reachable: true` (direct-mode sanity check)
- [ ] `npm run start:agent` with **no `AGENT_TOKEN` set** → note the pairing code it prints
- [ ] `POST /api/auth/register` (or `/login`) → save the `accessToken`
- [ ] `POST /api/connections/device/approve` with that code → bridge auto-connects within seconds, no token ever copied by hand
- [ ] `GET /api/connections` → `connected: true`
- [ ] `POST /api/extractions/fetch-master` (e.g. `masterType: "GROUPS"`) → `202`, note the `id`
- [ ] `GET /api/extractions/<id>` → `status: "SUCCESS"`
- [ ] `GET /api/extractions/<id>/result` → real Tally data comes back

🎉 First successful extraction, end to end through the actual Connector Bridge.
