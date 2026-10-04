# Ulmara — Backend

API and services for the Ulmara wallet: Account IDs, multichain transfers,
ERC-20 tokens, real-time updates, and the NGN fiat ramp.

Repository identity: **ulmara-backend**. The directory is named `avora-backend`
for historical reasons; the two names intentionally differ.

## Stack

- Fastify (`@fastify/cors`, `helmet`, `rate-limit`, `websocket`)
- PostgreSQL (Neon) + Prisma 7 (`@prisma/adapter-pg`)
- Redis + BullMQ for the OTP store, queues and cross-process events
- Chains: TON, BSC, ETH, SOL, BASE, POLYGON, TRON, BTC
- ERC-20 tokens (USDT/USDC) on the EVM chains, configuration-driven
- TriVerify-primary address validation (strict RPC fallback for BSC/Base)
- Auth: JWT (`jsonwebtoken`) + `bcryptjs`, with zero-downtime key rotation
- Email: Resend (default) / SendGrid / AWS SES behind one adapter interface
- Errors: Sentry (optional) + `pino` logging
- NGN ramp: Bitnob or Yellow Card behind one provider interface

## Project layout

```
src/
  server/         Fastify app + API entrypoint (server.ts)
  worker/         dedicated BullMQ worker entrypoint (separate process)
  routes/         account, auth, payment, ramp, transaction, wallet, health
  controllers/    request handlers per domain
  services/       business logic per domain (mirrors controllers)
    email/        email provider abstraction + adapters (resend/sendgrid/ses)
    ramp/         NGN ramp service + providers/ (bitnob, yellowcard)
  chains/         per-chain adapters, chain network config, token registry
  blockchain/     shared chain utilities (TriVerify + fallback)
  queues/         BullMQ queues + shared Redis clients
  jobs/           queue processor factories (consumed by src/worker)
  websocket/      authenticated real-time connection handling + event bridge
  middleware/     auth, rate-limit, error handling
  config/         env validation, jwt rotation, logger, sentry, database
  types/, utils/
scripts/
  verify-token-registry.ts   proves every token address against its live network
  queue-probe.mts            manual queue inspection helper
prisma/
  schema.prisma
  migrations/
```

## Setup

Redis is required (OTP store, BullMQ queues, cross-process events). It is
compose-managed:

```bash
docker compose up -d      # starts avora-redis with AOF + a named volume
```

```bash
npm install
cp .env.example .env     # then fill it in
npx prisma generate
npx prisma migrate deploy
npm run dev              # API,  http://localhost:4000
npm run dev:worker       # BullMQ workers, in a second terminal
```

`.env.example` documents every variable, where to obtain each credential, and
which values must be changed before production.

`docker compose down` keeps the data volume; `docker compose down -v` deletes it.
See `OPERATIONS.md` §4 for the durability configuration and what is still
recommended but not applied (managed/failover Redis, TLS, auth).

### Before you boot: `npm run verify:env`

Pointing this project at the wrong Postgres is the one mistake that has actually
caused an outage here, so it is checked mechanically rather than trusted to
memory. `verify:env` refuses to let you continue when:

| it refuses | why |
|---|---|
| `DATABASE_URL` is unset | nothing can be verified |
| the host is remote (Neon, any `*.neon.tech`) | a typo points disposable work at production. Override deliberately with `ALLOW_REMOTE_DATABASE=1`. |
| port **5434** | `avora-fe-pg` — a container that was **shared with another project** and is now stopped. Starting it again re-creates the 2026-10-03 failure. |
| port **5433** | held by another project's container. `verify:migrations` hardcoded that port and failed confusingly; it is now `PG_PORT`-overridable. |
| **0** migrations applied | `SELECT 1` succeeds against an empty database, so a reachable server proves nothing about the schema. |

That last row is why `GET /health/ready` now checks `_prisma_migrations` and not
just connectivity: during the 2026-10-03 outage every database route returned
500 while readiness reported `database: ok` for seven hours.

**Use a database this project owns.** Ulmara's is the `ulmara-pg` container on
port 5435. If you are working against a throwaway local environment rather than
a managed database, `docs/LOCAL-TEST-ENVIRONMENT.md` describes it — disposable
accounts, testnet balances, and the container/port layout.

## Scripts

| command | purpose |
|---|---|
| `npm run dev` | API with reload (no workers) |
| `npm run dev:worker` | workers with reload |
| `npm run build` | `tsc` to `dist/` |
| `npm start` | run the compiled API |
| `npm run start:worker` | run the compiled worker |
| `npm test` | vitest (needs `REDIS_URL`; the OTP suite uses a real Redis) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, type-aware (`eslint.config.js`) |
| `npm run lint:fix` | ESLint with autofix |
| `npm run verify:all` | lint + typecheck + test, the same gate CI runs |
| `npm run verify:env` | **run this before booting anything that touches the database** — refuses a remote host, the stopped shared container on 5434, another project's container on 5433, and a database with no migrations applied |
| `npm run verify:tokens` | read every configured ERC-20 contract on-chain and compare code/decimals/symbol |
| `npm run verify:redis` | restart Redis for real and assert queue + OTP + cache data survived |
| `npm run test:load` | concurrent load test for the rate limiter and PIN lockout (needs Redis) |
| `npm run prisma:deploy` | `prisma migrate deploy` — **the production release step** |
| `npm run prisma:status` | verify migrations are applied |
| `npm run prisma:generate` | regenerate the client |

## API documentation

Set `ENABLE_API_DOCS=true` and restart:

| route | what it is |
|---|---|
| `GET /docs/json` | OpenAPI 3.1 document |
| `GET /docs` | route listing (loads the document client-side) |

The document is **generated from the live Fastify route table**, so it cannot
describe a route that does not exist or omit one that does. Request and
parameter schemas are the same zod objects the handlers validate with
(`src/utils/requestSchemas.ts`), and the bearer scheme, auth requirements, tags
and shared error responses are attached per route in `src/utils/openapi.ts`.

Two honest limitations:

- The generator cannot introspect handler bodies. The zod schemas are applied
  *inside* handlers rather than attached to routes as Fastify JSON schemas, so
  they are imported and attached explicitly. They are the real schema objects,
  not restatements, so they still cannot disagree with runtime behaviour.
- Schemas that use `.transform()` (the pagination query) are described by their
  **input** side — the digit string a client actually sends — because JSON
  Schema has no notion of a transform.

A route added without documentation, or documented after deletion, **fails the
boot in development and CI** (`verifySpecMatchesRoutes`). That is the drift
check a hand-written spec cannot have.

`ENABLE_API_DOCS` is **refused in production** even when set, and logs a warning
saying so: an unauthenticated route inventory is reconnaissance. To generate
the spec for publication from CI, run with the flag on in a dev-mode process and
save `/docs/json`.

## Processes: API and workers are separate

Production runs two processes against the same Postgres and Redis:

```
npm start            # API: HTTP + WebSocket only. Does NOT consume queues.
npm run start:worker # BullMQ workers: transactions + ramp.
```

`src/server/server.ts` deliberately imports no worker module. A worker
crash/restart therefore never takes the HTTP surface down, the two scale
independently, and an API deploy does not interrupt in-flight jobs. Workers
publish user-scoped real-time events over Redis pub/sub; the API forwards them
to that user's sockets.

Graceful shutdown: `SIGTERM`/`SIGINT` makes the worker stop fetching new jobs
and **wait for the job in flight** to finish (30s hard deadline), then close
Redis/Postgres and flush Sentry. Jobs that had not started stay in Redis and
are picked up by the next worker.

## Release steps (production)

```bash
npm ci
npx prisma generate
npx prisma migrate deploy     # REQUIRED — see "Migrations" below
npm run build
npm run typecheck && npm test
# then: start API process, then start worker process
```

### Migrations

`npx prisma migrate deploy` is a **required production release step** and must
complete before new application code serves traffic.

- Never rely on a migration merely existing in `prisma/migrations/`. Verify it
  is actually applied with `npx prisma migrate status` (it prints
  "Database schema is up to date!" when the database matches).
- Use `migrate deploy` in production. `migrate dev` is for local development
  only: it can reset the database and is refused against a non-dev datasource.
- A release that ships a migration but skips `migrate deploy` will fail at
  runtime the first time new code reads or writes the new column/table. This is
  why the API's `/health/ready` reports the database explicitly.

Full staging/branching, backup and recovery guidance: **[OPERATIONS.md](./OPERATIONS.md)**.

## JWT rotation procedure

Sessions are signed with a single current key, and a rotation lets that key be
replaced without logging anyone out. Three states:

| state | `JWT_SECRET` | `JWT_PREVIOUS_SECRET` | effect |
|---|---|---|---|
| steady | current key | unset | only the current key verifies |
| rotating | **new** key | **old** key | both verify; new tokens use the new key |
| retired | current key | unset | old tokens are rejected outright |

A previous key is honoured **only** while `JWT_PREVIOUS_SECRET_RETIRE_AT` is in
the future. If that variable is missing or already past, the previous key is
never consulted, so a forgotten variable cannot silently keep a compromised key
valid forever.

### Rotating (no forced logouts)

1. **Generate the new key** and keep it secret:
   ```bash
   openssl rand -hex 32
   ```
2. **Set the window on every instance.** The window must be LONGER than
   `JWT_EXPIRES_IN` so that no still-valid session is cut off. For a 7-day
   session, use 8 days:
   ```bash
   JWT_SECRET=<new key>
   JWT_PREVIOUS_SECRET=<the old JWT_SECRET value>
   JWT_PREVIOUS_SECRET_RETIRE_AT=<ISO-8601, now + 8 days>
   ```
   ISO-8601 with a `Z` suffix, e.g. `2026-10-08T00:00:00.000Z`. Compute it with
   `date -u -d '+8 days' +%Y-%m-%dT%H:%M:%S.000Z`.
3. **Deploy / restart every instance** (API and workers) so all of them accept
   both keys. If some instances keep the old key, requests routed to them
   during the window fail.
4. **Confirm the rotation is live:**
   ```bash
   curl -sS -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
     https://api.example.com/internal/config | jq .data.jwt
   ```
   Expect `previousKeyActive: true` and a positive
   `millisecondsUntilPreviousKeyRetires`. Every instance must agree.
5. **Wait for the window to elapse.** Old tokens then fail with 401 and users
   are asked to sign in again.
6. **Retire the old key** — remove both variables and redeploy:
   ```bash
   # JWT_PREVIOUS_SECRET=            (delete)
   # JWT_PREVIOUS_SECRET_RETIRE_AT=  (delete)
   ```
   Confirm `previousKeyConfigured: false` on `/internal/config`.

### Emergency rotation (suspected compromise)

Do not open a window — a compromised key must stop working immediately:

1. Set `JWT_SECRET` to a brand-new value and **remove** `JWT_PREVIOUS_SECRET`
   and `JWT_PREVIOUS_SECRET_RETIRE_AT` in the same change.
2. Deploy. Every token signed with the old key is rejected from that moment.
3. `Session` rows survive, but their tokens no longer verify, so every user must
   sign in again. That is the intended outcome.

### Rotating other secrets

`JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, `TRIVERIFY_API_KEY`, provider API
keys, `BITNOB_CLIENT_SECRET`, `BITNOB_WEBHOOK_SECRET`, `YELLOW_CARD_API_SECRET`
and `SENTRY_DSN` are all read from the environment at boot. There is no
dual-key support for any of them except JWT: rotate them by changing the
variable and restarting. Provider keys can be rotated in the provider's
dashboard first (overlap) and the old value removed once the new one is live.

Generate strong values with `openssl rand -hex 32` (or `-hex 24` for
`INTERNAL_API_TOKEN`). Never commit a filled-in `.env`.

## Monitoring and uptime

- `GET /health` — liveness. Dependency-free, always 200 while the process is
  up. **This is the endpoint an uptime monitor should poll.**
- `GET /health/ready` — readiness. Verifies Postgres and Redis; 503 when
  degraded so a load balancer stops routing.
- `GET /internal/queues` — BullMQ depth and backlog per queue.
- `GET /internal/config` — non-secret runtime configuration, JWT rotation
  state, chain ids, and any configuration problems. Never returns secrets.

The `/internal/*` routes require `Authorization: Bearer $INTERNAL_API_TOKEN`.
If that variable is unset they are open in development and return **404** in
production, so an unconfigured deployment exposes nothing.

### Wiring an external uptime monitor

Any of UptimeRobot, Better Stack, Pingdom, Checkly or a Kubernetes probe works.
A minimal UptimeRobot configuration:

| setting | value |
|---|---|
| monitor type | HTTP(s) |
| URL | `https://api.example.com/health` |
| interval | 5 minutes |
| timeout | 30 seconds |
| assert JSON contains | `"status":"ok"` |

Kubernetes equivalents:

```yaml
livenessProbe:
  httpGet: { path: /health,  port: 4000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /health/ready, port: 4000 }
  periodSeconds: 5
  failureThreshold: 3
```

Alert on `/health/ready` returning 503 (dependency down) and on
`/internal/queues` showing a growing `waiting`/`backlogSeconds`.

## Status

- Auth, accounts, wallets, internal + external transfers, PIN lockout,
  idempotency and rate limiting: implemented and tested.
- Email verification: implemented for Resend / SendGrid / SES. Codes are stored
  in Redis (10-minute TTL) and only the code's HMAC is persisted.
- WebSockets: authenticated with the session JWT, per-user event isolation.
- ERC-20: USDT/USDC on the EVM chains, with token transfer construction,
  verification, gas estimation and balance checks.
- NGN ramp: Bitnob and Yellow Card adapters, webhook signature verification and
  idempotent processing.
- Workers: separate process with graceful shutdown.
- Testnet: Ethereum Sepolia, BNB Smart Chain Testnet, Base Sepolia, Polygon
  Amoy, Solana Devnet. See `src/chains/networks.ts` for the full table.

See [OPERATIONS.md](./OPERATIONS.md) for staging, backups and disaster recovery.
