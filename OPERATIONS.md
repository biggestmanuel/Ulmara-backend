# Ulmara backend — Operations runbook

Covers release/migration mechanics, staging on Neon branches, backup and
disaster recovery, and queue durability.

Anything in this document that was **measured** in this environment is marked
*Measured*; anything that is provider-documented rather than verified here is
marked *Provider-documented*.

---

## 1. Release and migrations

### The production release step

```bash
npm ci
npx prisma generate
npx prisma migrate deploy      # REQUIRED, before new code serves traffic
npm run build
npm run typecheck
npm test
# start API process, then start worker process
```

`npx prisma migrate deploy` is **not optional**. It applies pending migrations
from `prisma/migrations/` in order and records them in `_prisma_migrations`.

### Making it impossible to skip a migration

The failure mode this prevents: code is deployed that reads/writes a column that
no migration ever added, and every request touching that table 500s.

Defences in place:

1. **Release checklist + scripts.** `npm run prisma:deploy` exists so the command
   is a script, not tribal knowledge. README and this document both state it as
   a required step.
2. **CI.** `.github/workflows/ci.yml` runs `npm run typecheck` and `npm test` on
   every push and PR to `main`. Typecheck includes the test files, so a schema
   change that no test exercises is still caught.
3. **Verify, do not assume.** `npm run prisma:status` prints
   "Database schema is up to date!" only when the database actually matches.
   Never treat the presence of a folder in `prisma/migrations/` as proof that a
   migration was applied.
4. **Readiness surfaces it.** `/health/ready` runs a real query against Postgres
   and returns 503 when it fails, so a broken schema shows up on the load
   balancer before users do.
5. **Deploy order.** `migrate deploy` runs *before* the new processes start. The
   additive-migration rule below makes that safe.

### Migration rules

- **Additive first.** Add a nullable column / new table in release N; start
  writing it in release N+1; make it required in a later release. Never ship a
  release that both writes a new column and depends on it being non-null.
- **Never run `migrate dev` against production.** It can reset the database and
  is intended for local development only. `migrate deploy` is the only command
  allowed against a deployed database.
- **Never edit an applied migration.** Create a new one. Prisma records a
  checksum per migration and will refuse to start if an applied one changed.
- **Migrations that need a long lock** (`CREATE INDEX` without `CONCURRENTLY`,
  `ALTER TABLE ... TYPE`) should be written by hand into a new migration folder
  rather than generated, so the lock behaviour is reviewed.

### Rolling back

Application code rolls back by redeploying the previous image. **A migration does
not roll back with it.** If a migration must be undone, write a new forward
migration that reverses it (`DROP COLUMN`, etc.) and deploy that. Neon
point-in-time restore (section 4) is the blunt instrument for data loss.

---

## 2. Staging with Neon branching

### What a Neon branch is

A branch is a full, isolated copy-on-write clone of the database with its own
connection string. It is the mechanism Neon recommends for staging and for
testing a restore. It is a copy of the *schema and data*; it is **not** a
separate Neon project, so billing and limits are shared with its parent.

### Current state

**No staging branch exists.** Nothing in this repository provisions one, and no
`NEON_BRANCH_ID` appears in the environment. Creating one requires Neon account
credentials that are not part of this codebase. The steps below are the
procedure to follow once credentials are available.

### Creating a staging branch

1. **Create the branch.** Neon console → *Branches* → *Create Branch* from the
   production branch, at a point in time close to the change you want to test.
   Or with the Neon CLI:
   ```bash
   neonctl branches create --project-id <project-id> --name staging --parent production
   ```
   Note the branch's connection string — it is a different host
   (`ep-...-staging...` or a different `-pooler` host) on the same cluster.

2. **Configure the staging deployment** with the branch's own credentials:
   ```bash
   DATABASE_URL=<branch pooled connection string>
   DIRECT_URL=<branch direct connection string>
   ```
   Everything else (Redis, provider keys) should point at staging resources
   too. **Do not** point staging at production Redis or production provider
   accounts: a staging webhook or a staging fiat deposit must not be able to
   move real money or collide with production OTP keys.

3. **Apply migrations to staging:**
   ```bash
   DATABASE_URL=<branch pooled url> npx prisma migrate deploy
   ```

4. **Run the API and workers against staging**, then test:
   ```bash
   npm ci && npx prisma generate
   npm test
   DATABASE_URL=<branch url> npm start
   ```
   At minimum verify: `/health` and `/health/ready` return 200, signup → email
   verification end to end, a transfer prepare → submit round trip, and
   `/internal/queues` reporting both queues.

5. **Isolate production.** Confirm before going live that the production
   deployment is not pointing at the branch: check `/internal/config` on the
   production host and confirm the host in `DATABASE_URL` is the production
   endpoint, not the branch.

### Deleting a staging branch

```bash
neonctl branches delete <branch-id> --project-id <project-id>
```

Branches share storage with their parent, so deleting one reclaims the space it
was using. Data on a deleted branch is gone.

---

## 3. Backups and disaster recovery (Postgres)

*Provider-documented (Neon):* Neon stores every project's data on a
copy-on-write filesystem and provides **point-in-time restore (PITR)** built into
that storage layer, with **up to 30 days of retention** and LSN-level
granularity. That means a restore to an arbitrary second inside the retention
window is a first-class operation, not something you assemble from dumps.
Neon also takes continuous backups; branching lets you clone a historical point
in time to rehearse a restore before performing one.

### Recovery procedure (PITR)

1. **Assess.** Identify the time window containing the bad data. Anything in the
   last 30 days is restorable; anything older is not.
2. **Rehearse on a branch.** Create a branch from the moment just before the
   incident and run your verification against it. This is the point of PITR +
   branching: you can prove the restore is good before touching production.
   ```bash
   neonctl branches create --project-id <id> --name restore-test \
     --parent production --created-at "2026-09-20T10:00:00Z"
   ```
3. **Rehearse the migration state.** Point the branch URL at a scratch instance
   and run `npx prisma migrate status`, then `migrate deploy` if it is behind.
   A database restored to a moment before a migration will be *behind* the
   deployed application code, which is the most common restore failure.
4. **Promote the branch** (Neon console → the branch → *Promote* / or
   `neonctl branches promote`) to make it the production branch, then swap
   `DATABASE_URL` in the production deployment. Alternatively, promote the
   original branch's parent.
5. **Redeploy** the API and worker processes and confirm `/health/ready` is 200.
6. **Reconcile.** Rows restored to a past point are missing everything written
   after it. In particular:
   - `Transaction` rows created after the restore point are gone. Compare on-chain
     `txHash`es in the ledger against the chain, and reconcile any broadcast that
     succeeded but whose row was rolled back.
   - `RampTransaction` rows restored to `PENDING` will be picked up by the ramp
     worker's reconciliation, which queries the provider for the authoritative
     status — so do **not** manually flip ramp rows after a restore; let the
     worker resolve them.
   - Sessions restored to `PENDING` are simply expired sessions; users sign in
     again.

### Recovery configuration required

| requirement | why |
|---|---|
| Neon project on a plan with PITR history | `migrate status` and a restore are impossible without it |
| `DATABASE_URL` (pooled) **and** `DIRECT_URL` (direct) in the environment | `migrate deploy` should use `DIRECT_URL`; PgBouncer transaction pooling interferes with DDL |
| `sslmode=require` on every connection string | Neon requires TLS; a restore over plaintext is refused |
| Regular `npx prisma migrate deploy` runs | PITR restores to a point in time; the schema can only be advanced by re-running migrations |
| Access to the Neon console/CLI for the operator on call | PITR and branch creation are console/CLI operations |

---

## 4. Queues: what survives, and what does not

This section is based on **Measured** behaviour in this environment
(Redis 8.0.5 in the `avora-redis` container, BullMQ 6.x), not on assumptions.

### Configuration in effect on the `avora-redis` container

`avora-redis` is now defined in `docker-compose.yml` (`docker compose up -d`)
rather than by an ad-hoc `docker run`. The container keeps the same name and
publishes 6379, so `REDIS_URL` and the test suite are unaffected.

| setting | value | consequence |
|---|---|---|
| `appendonly` | **yes** | write-ahead log enabled; durability no longer rests on snapshots alone |
| `appendfsync` | `everysec` | at most ~1 s of writes at risk on a hard crash |
| `save` | `900 1 300 10 60 10000` | RDB kept alongside AOF for fast cold start and a single-file backup artefact |
| `maxmemory-policy` | `noeviction` | **required for BullMQ** — Redis will never silently evict a job key |
| `maxmemory` | `256mb` | with `noeviction`, filling this makes writes **fail loudly** instead of dropping work; it also stops an unbounded dev Redis from being OOM-killed by the Docker VM |
| volume mount | **`avora-redis-data` → `/data`** | survives `docker compose restart`, `down`, and `up` |
| `restart` | `unless-stopped` | Redis returns by itself after a crash or a Docker/WSL restart |
| Redis version | 8.10.2 (`redis:8-alpine`) | pinned to a major, not a floating `redis:alpine` |

> **Measurement caveat — read this before trusting a `redis-cli` result.**
> An earlier revision of this section reported these values as
> "Redis 8.0.5 in the `avora-redis` container". They were not: a **native
> `redis-server` process was running inside WSL on `*:6379`** and shadowed the
> container for anything launched in WSL. It was identifiable by
> `INFO server` → `process_id` (not `1`) and `executable`
> (`/home/.../redis-server`, i.e. a path outside the container). Anything run in
> WSL — including this test suite — was talking to that stray process, not to
> Docker. **Always confirm the identity with `process_id: 1` before trusting a
> Redis measurement.** See the WSL gotcha in `AGENTS.md`.

### Measured persistence behaviour

`bash scripts/verify-redis-persistence.sh` (`npm run verify:redis`) performs a
real restart and asserts the results; it does not merely read the config. Last
run: **all checks passed**.

| check | result |
|---|---|
| Config in effect after `docker compose up` | `appendonly=yes`, `appendfsync=everysec`, `noeviction`, `maxmemory=256mb`, volume `avora-redis-data -> /data` |
| BullMQ list + meta hash + job hash written via ioredis | survived `docker compose restart` |
| OTP-store key (keyed HMAC) with a real `EX` TTL | value survived; TTL still live at 896 s of 900 s after the restart |
| Cache entry | survived |
| AOF on disk | `appendonlydir` present with 3 files |
| `src/services/auth/verificationCodeStore.test.ts` (real Redis, Lua + EX TTL) | 16/16 pass against the restarted instance |
| BullMQ enqueue → worker dequeue | job left `waiting` and was picked up by a worker built from the app's own factory |

### Measured queue behaviour

| scenario | result |
|---|---|
| Job queued (`waiting`) with no worker running | stays `waiting`; not consumed by the API process |
| Redis container **restarted** while a job was `waiting` | job survived, and a worker dequeued it afterwards |
| Job **in flight**, worker **SIGKILLed** (no graceful drain) | job stayed `active` for ~60 s, then BullMQ's stalled-job mechanism **re-queued and reprocessed it** at ~T+60–75 s, with `attemptsMade=0` (the interrupted attempt did not consume retry budget) |
| Graceful `SIGTERM` to the worker | `worker_shutdown_start` → `worker_drained` → `worker_shutdown_complete`; the in-flight job finishes before exit |

So:

- **Queued jobs survive a Redis restart**, now with AOF as well as RDB.
- **In-flight jobs are recovered automatically** by BullMQ within roughly one to
  two minutes, without consuming a retry attempt.
- **A graceful worker shutdown is still strongly preferred**: it drains in
  flight immediately instead of waiting out the stall detector.

### Retry and recovery semantics

- Retries are declared **per job** when it is added, not per worker:
  - `process-transaction`: 5 attempts, exponential backoff from 5 s.
  - `reconcile-ramp`: 5 attempts, exponential backoff from 60 s.
- A transaction broadcast that throws marks the ledger row `FAILED` before
  rethrowing, so a retry can never leave a row stuck in `PROCESSING` with a
  live broadcast behind it.
- Status polling uses `delay`, never an in-process sleep, so a restart cannot
  lose a pending check-transaction.
- A job that exhausts its attempts stays in BullMQ's `failed` set for
  inspection; it is **not** auto-retried by anything.
- Re-enqueueing is safe for broadcasts: `transactionService.broadcast` claims
  the row with an atomic `PENDING -> PROCESSING` update, so a duplicated job
  cannot broadcast the same signed transaction twice.

### Production Redis / BullMQ recommendations

Items 1–3 are **now applied** in `docker-compose.yml` and verified by
`npm run verify:redis`; they are restated here because they remain the
production requirements, and because items 4–7 are still open.

1. **Enable AOF** (`appendonly yes`, `appendfsync everysec`). RDB alone can lose
   up to a minute of queued work, and this codebase's jobs move money.
   ✅ applied in `docker-compose.yml`, verified across a real restart.
2. **Keep `maxmemory-policy noeviction`.** Any eviction-capable policy
   (`allkeys-lru`, `volatile-lru`) can discard BullMQ job keys and silently lose
   transfers. If memory pressure is a real risk, raise `maxmemory` and alert
   instead of enabling eviction.
   ✅ applied (`noeviction` + an explicit `maxmemory` of 256mb).
3. **Mount a persistent volume** for the data directory.
   ✅ applied (`avora-redis-data` → `/data`), verified across a real restart.
4. **Use a managed Redis with automatic failover** (ElastiCache / Redis
   Enterprise, Upstash, Aiven, Redis Cloud). A single-node Redis is a
   single point of failure for both the OTP store and the queue.
   ⛔ still open — needs an external account and spend, so it cannot be done
   locally.
5. **Enable TLS and authentication** in production (`rediss://` and a password
   or ACL user). The dev URL is plaintext on loopback only.
   ✅ the **application is verified to work** against TLS + ACL — see
   "Managed Redis: TLS and ACL" below. What remains open is only *provisioning*
   such an instance, which needs an external account and spend.
6. **Do not run the OTP store and BullMQ on a Redis instance configured for
   eviction**, for the reason above — the OTP keys are the same class of data.
7. **Back up nothing yourself** for Redis: the queue is reconstructible from the
   `Transaction`/`RampTransaction` tables, and Redis holds no record that is not
   derived from Postgres. Treat Redis as a cache-plus-workqueue, not a system of
   record.
8. **Alert on depth and age**, not just failure: watch `waiting` and
   `backlogSeconds` from `/internal/queues` and the periodic
   `{"event":"queue_depth"}` log line.
9. **Single-node Redis cannot survive a host loss.** The compose volume protects
   against a *container* restart or recreate only. It is not a backup, and it is
   not shared storage — see item 7.

### Managed Redis: TLS and ACL

A `rediss://` URL in `.env` is a claim. `npm run verify:redis:tls` tests it
against a real TLS-only, ACL-protected Redis it starts on port 6380, isolated
from the development instance, and reports what actually works.

**Run it:** `npm run verify:redis:tls`

It stands up `docker-compose.tls-redis.yml` with the plaintext port disabled
outright (`--port 0`), `user default off`, and an app user scoped to the app's
real key space, then checks 9 things including the two that matter most:

- the **real OTP suite** (16 tests: `EX` TTL, Lua) run against `rediss://` with
  the ACL user — not a smoke test, the operations verification codes depend on;
- a **published WebSocket event actually delivered** to a subscriber over TLS,
  because a connection that dials successfully but delivers nothing is invisible
  to a health check.

#### Three findings that a plaintext dev Redis cannot surface

**1. Pub/sub channels are a separate ACL namespace from keys.** Redis 7 scopes
channels with `&pattern`, not `~pattern`. A user granted `~ulmara:*` has access
to *no channels at all*, so `src/websocket/emit.ts` fails with `NOPERM No
permissions to access a channel` — and the API still passes every health check
while cross-process WebSocket events silently stop arriving. The user needs both:

```
~ulmara:* ~bull:*      # keys:      OTP codes, BullMQ
&ulmara:* &bull:*      # channels:  WebSocket user events
```

**2. `rediss://` alone is not enough for a private CA.** With a provider-issued
or self-signed certificate and no trusted CA, the connection is refused with
`unable to verify the first certificate`. Fixes, both verified:

- set `NODE_EXTRA_CA_CERTS` in the process environment — **it must be set before
  the process starts.** Node builds and caches its TLS trust store on first use,
  so assigning it from inside a running process silently does nothing. Testing it
  in-process would wrongly conclude the variable is useless.
- or use a publicly-trusted certificate, where no extra configuration is needed.

There is no application code path for a custom CA; every Redis connection is
`new Redis(env.REDIS_URL)` with no options. That is adequate for a publicly
trusted endpoint and for the `NODE_EXTRA_CA_CERTS` route, and is called out here
because it is a real constraint when choosing a provider.

**3. The username in the URL is required.** `redis://:password@host` authenticates
as `default`, which a managed instance normally disables. The ACL user must be
named, and the app's Redis key space is exactly `ulmara:*` and `bull:*` — the PIN
lockout lives in Postgres and the rate limiter in process memory, so nothing else
needs a grant.

#### What the app user must be granted

`npm run verify:redis:tls` uses this ACL, and every line is justified by a check
it runs:

| Grant | Why |
| --- | --- |
| `~ulmara:* ~bull:*` | OTP codes (`ulmara:otp:<channel>:<userId>`), BullMQ keys |
| `&ulmara:* &bull:*` | `WS_PUBSUB_CHANNEL` = `ulmara:ws:user-events` |
| `+@all -@admin -@dangerous` | data commands, but not server administration |
| `-config -acl -flushall -flushdb` | no config reads, no ACL self-inspection, no wiping |
| `+acl\|whoami` | read-only; lets the harness prove `AUTH user pass` is sent |
| `+client\|setname +client\|setinfo` | ioredis sends these on connect |

`CONFIG`, `ACL LIST`, `SET` from another user, and any key outside the two
prefixes are each asserted to be **denied**, so the ACL is proven restrictive
rather than assumed to be.

### OTP codes in Redis

Verification codes are stored in Redis with a 10-minute TTL and a retention
grace window so a late submit can be reported as expired. The raw code is never
persisted — only a keyed HMAC — so a Redis dump cannot be replayed as a valid
code. Losing Redis loses in-flight codes (users tap "Resend code"); it does not
create a security exposure and does not affect any financial record.

---

## 5. Incident runbook

### API returns 503 on `/health/ready`

1. Read which check failed: `{"checks":{"database":{"ok":false,"error":...}}}`.
2. Database down → check the Neon project status and the connection string;
   confirm `npx prisma migrate status` can reach it.
3. Redis down → the API still serves REST (the WebSocket event bridge degrades
   and logs `ws_bridge_unavailable`), but OTP delivery and queueing are down.
   Start the worker only once Redis is back.

### Queue is backing up

1. `GET /internal/queues` — is `active` pinned at max concurrency?
2. Are the worker processes running? `ps` / process manager, not the API host.
3. Check `{"event":"worker_job_failed"}` log lines for a repeating failure.
4. A worker crash is isolated: the API is unaffected, so this is not a user-facing
   outage for anything except the affected async work.

### Suspected credential compromise

Follow the emergency JWT rotation in README §"Emergency rotation", then rotate
the affected provider key in its dashboard. Provider credentials are read only
at boot, so a rotation needs a restart of every process.

### Real funds moved but the ledger disagrees

The ledger row and the chain are the two sources. Reconcile by comparing each
`Transaction.txHash` against the chain's receipt status. External transfers are
already verified against a single-use stored intent before broadcast, so a
mismatch should not occur; if it does, do not retry blindly — an
`ExternalTransferIntent` is single-use and its status in Postgres shows whether
the broadcast was already enqueued.
