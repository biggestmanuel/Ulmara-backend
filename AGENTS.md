# Ulmara Backend — Agent Instructions

## Stack
Node/TypeScript, Fastify, PostgreSQL (Neon), Prisma, Redis, BullMQ, WebSockets, REST.
Dev environment: WSL2 Ubuntu, Docker Desktop for Redis (the `avora-redis` container).

## Standing Workflow (always follow)

Before coding:
- Explore the actual project structure and read relevant existing files/patterns before writing anything
- Explain the implementation plan and list exactly which files will change, before making changes
- Reuse existing components/utilities/patterns — don't reinvent what already exists
- Follow existing architecture and conventions
- Keep changes small and focused — don't bundle unrelated refactors into a fix
- No unnecessary new dependencies
- Validate all inputs, handle errors explicitly
- Use strict types (no `any` unless truly unavoidable)
- Consider loading/empty/error/success states for any user-facing flow

After coding:
- Review your own changes for: type errors, runtime issues, broken imports, security issues, edge cases, regressions, responsiveness (if relevant), duplication
- Run all available tests, lint, and build before declaring something done
- If something fails, investigate the real root cause — do not hide, suppress, or work around a failure without understanding it
- If you find a better approach than what was asked, flag it with trade-offs instead of silently changing direction
- If a task is ambiguous or conflicts with existing architecture, stop and ask rather than guessing
- Test in a **release build** first — rule out dev-mode overhead.

### Commit and push after every file change

**Never leave a file change sitting uncommitted.** When a change is finished and
verified, commit it and push it before moving on. Work that lives only in a
working tree is work that is one `git checkout .` away from being lost, and it
cannot be reviewed by anyone else.

What "done" means for a change, in order:
1. `npm run verify:all` green, and `npm run build` clean.
2. **Code-review your own diff first.** Look for credentials, private keys, mnemonics and tokens; broken imports; dead code; a comment that contradicts the code around it; and anything the commit message claims that the diff does not actually do. Report what you found.
3. Commit **one logical change per commit** — never bundle unrelated fixes.
4. Push to the working branch.
5. Confirm CI is green on the pushed commit.

Rules that constrain the above:
- **Never push to `main`.** `main` is the user's to merge, through PR #1. Push to `hardening-2026-09-30`.
- **Never commit a secret.** `.env`, `.solana-e2e-keypair.json` and `.tls-test-certs/` are ignored and must stay that way; the live credentials live in `~/dev/ulmara-fe-backend.env`, outside the repository entirely.
- **Never leave a copy of a credential-bearing file behind.** A backup of `.env` is itself a leak: a stray `*.env.bak` holding `RESEND_API_KEY` was created and then had to be hunted down and deleted. If you need to record a config change, write down the *variable name* and the fact that it changed — never copy the file.
- If the gate cannot run (no database, no Redis), **say so in the commit message** rather than quietly skipping it. An unverified commit that says so is useful; one that implies verification it never got is not.

## Two gaps found in review — both now fixed (`722d1bb`)

Kept as a record of what was wrong, because both were invisible from the code and
only a measurement exposed them.

**1. Requests to unrouted paths bypassed the global rate limiter. FIXED.**
`@fastify/rate-limit` installs its `onRequest` hook from inside `onRoute`, so the
hook exists **only on routes that were registered**. An unmatched path has no
route, therefore no hook, therefore no counter. Measured: 130 requests to
`/api/account/me` from one IP produced 30 × `429`; 130 to unknown paths produced
**0**. The documented 100/min-per-IP ceiling did not apply to exactly the traffic
an attacker would send, and each miss wrote ~15 log lines, so one IP could grow
the log without bound. Pre-existing — `eb56084` touched no rate-limit code, and
Fastify's default not-found handler ran at the same point in the lifecycle.

`setNotFoundHandler` now runs its own IP-keyed limiter at 60/min, verified live
(90 misses → 60 × `404` then 30 × `429`, `retry-after: 59`, standard envelope). It
is a **separate counter** from the global one so typos cannot throttle real
traffic. Two things to know before touching it:
- It **must** be registered after `await app.register(rateLimit, …)`.
  `createRateLimit` only exists once the plugin is attached; creating it earlier
  throws `app.createRateLimit is not a function` at boot.
- The 429 is built explicitly rather than by throwing out of the not-found
  handler, so it does not depend on Fastify routing that throw. The text comes
  from `RATE_LIMITED_MESSAGE` so it cannot drift from the route limiters'.

**2. CI could not catch a route added without an OpenAPI entry. FIXED.** This
file previously claimed it could, and that claim was wrong. `verifySpecMatchesRoutes`
runs only at a non-production boot, and no CI step boots the API — the workflow is
`lint`, `typecheck`, `test`, the Redis checks and `migrate deploy`/`status`. Both
test route lists were hand-maintained: `openapi.test.ts` carried 49 typed entries,
and `openapiRoutes.test.ts` derives its list from `Object.keys(ROUTE_DOCS)` and
then asserts `ROUTE_DOCS` against it — comparing the spec with itself, so it can
never detect a missing entry.

`app.routeDocsGuard.test.ts` now builds the **real** app with the same module
mocks the other app-level tests use, captures the real route table the way
`buildApp` does, and asserts `verifySpecMatchesRoutes` does not throw. Proven by
deleting the `POST /api/auth/logout` doc entry and watching it fail with
`OpenAPI drift: routes missing from the OpenAPI document: POST /api/auth/logout`.
**When you add a route, this is what will fail** — that is the intended signal.

## Verification standard
Every claim of "done" or "working" must be backed by actual test output, not assumption. Report exact test pass/fail counts, not just "tests pass." If you cannot verify something (e.g. no live server/DB in this environment), say so explicitly rather than describing untested code as verified.

## Known architecture facts (verify against current code before relying on these — this section may be stale)

- Chain identifiers are UPPERCASE everywhere on the wire (ETH, BTC, BSC, BASE, POLYGON, TRON, SOL, TON) — this is the established convention across Prisma schema, zod validation, and all controllers. Do not introduce lowercase chain identifiers without checking this is still true.
- PIN authorization is gated through `pinLockoutService` — reuse this for any new PIN-gated flow rather than building parallel logic. Login, transfer and changePin PIN lockouts share one counter/cooldown by design. `recordFailure` refuses to advance the counter while a lockout is already active, so a concurrent burst cannot emit a second `pin_lockout_armed` event for one real lockout.
- **`set-pin` is first-time only; `change-pin` is the only way to replace a PIN.** `setPin` used to hash and write unconditionally — no check for an existing PIN, no proof of the current one — which made it a way around everything `changePin` enforces. Anyone holding only a session token could replace a victim's PIN with a value they chose and then pass the transfer gate with it, so the PIN was not a second factor. `setPin` now returns `409 A PIN is already set for this account`, and its write is a **claim**: `pinHash: null` in the `where` of an `updateMany`, so of two concurrent first-time calls exactly one wins. A read-then-write would let both through. The bcrypt hash is computed after the cheap existence checks so a refused call costs no CPU, and `set-pin` shares `changePinLimit` (5/min) for the same reason `changePin` is limited. **Never add an endpoint that overwrites a credential field without first proving knowledge of the current one** — grep the service for `data: { …Hash` and check each one.
- External-wallet transfers use a prepare/submit two-step flow with server-persisted, single-use, expiring intents — submit must always verify against the stored intent, never trust client-submitted transaction details directly. For an ERC-20 transfer the signed tx must target the token CONTRACT with `value == 0` and calldata `transfer(recipient, amount)`; the amount is checked at the token's own decimals (BSC's USDT/USDC are 18-decimal, Ethereum's are 6).
- TriVerify (friend's SDK) is used for address/network validation on ETH/BTC/SOL/TRON/SUI/TON/Aptos/Polygon; ethers.js fallback is used for BSC/Base.
- Chain IDs are env-driven (`ETHEREUM_CHAIN_ID`, `BSC_CHAIN_ID`, `BASE_CHAIN_ID`, `POLYGON_CHAIN_ID`) and resolved only through `getEvmChainId` in `src/chains/chain.network.ts`. Never hardcode a chain ID. `src/chains/networks.ts` documents every supported network but is documentation only — the app never reads a chain id from it.
- **SPL tokens follow the same single-source rule as ERC-20**: metadata lives only in `src/chains/solana/tokens.ts`, resolved via `resolveSplToken`/`requireSplToken`/`listSplTokens`. `npm run verify:solana` proves every entry against the cluster — existence, program ownership, and that the registered `decimals` matches the chain. A decimals mismatch is the worst token bug available (1 USDC becomes 1e6), so the registry is a claim to be checked, never trusted.
- **Do not add `@solana/spl-token`.** It was installed, measured and removed: it pulls `bigint-buffer` (**GHSA-3gc7-fjrx-p6mg**, high-severity buffer overflow in `toBigIntLE()`, *every published version affected* — nothing to upgrade to), and npm's suggested "fix" is a downgrade to `0.1.8`. The two instruction layouts it would provide are hand-encoded in `src/chains/solana/spl.ts` against fixed on-chain formats, and proved by `simulateTransaction` on Devnet — the SPL Token program decodes our bytes and fails only on semantics. Re-derive that proof before changing a single byte of an encoder.
- `SOLANA_CLUSTER` decides which mints are valid; a mint address only means anything on the cluster it was issued on. Unset means "infer from the RPC URL, defaulting to devnet".
- ERC-20 token metadata lives ONLY in `src/chains/tokens/registry.ts` (plus optional `ERC20_TOKEN_CONFIG` overrides). Business logic must resolve tokens through `resolveToken`/`requireToken`/`listTokens` and must never hardcode an address or a decimals value. Run `npm run verify:tokens` to prove every entry against its live network.
- CORS is allowlist-based via `ALLOWED_ORIGINS` env var — never revert to `origin: true`.
- **Every error leaves this app as `{ success: false, message }` — including a 404.** A router miss is the one error that never reaches `setErrorHandler` (Fastify's router rejects the unmatched path itself), so it used to answer `{ message: "Route GET:/x not found", error: "Not Found", statusCode: 404 }` with no `success` key. That is not cosmetic: the client only surfaces a server message when the body is exactly `{ success: false, message }`, so the 404 a caller most wants to read was the one whose message got discarded, while a 404 from a service read fine. `setNotFoundHandler` in `src/server/app.ts` closes it. **If you add a Fastify plugin or hook that can answer an error, it must produce `errorResponse(...)`; do not let a raw Fastify body escape.** The message deliberately names the method and path — the route table is published at `/docs/json`, so "wrong verb on a real route" is not a disclosure.
- **`trustProxy` decides whether rate limiting works.** Every limiter keys on `request.ip`, which Fastify derives from `X-Forwarded-For` only when a proxy is trusted (`resolveTrustProxy` in `src/server/app.ts`, driven by `TRUSTED_PROXIES` / `TRUSTED_PROXY_COUNT`). Unset behind a proxy means all users share one budget per route — a single abusive client locks everyone out of `/login`. Never set it to `*` on a directly-reachable app: a client can then forge the header to escape its own limit. `npm run test:load` sets it to the loopback addresses and proves both the sharing and the separation.
- **The OpenAPI document is generated from the live route table** (`src/utils/openapi.ts`), and `verifySpecMatchesRoutes` fails the dev/CI boot if a route is undocumented or a documented route was deleted. Add a route → add a `ROUTE_DOCS` entry, or the build breaks. No OpenAPI *library* is used: `@fastify/swagger-ui` pulls in `@fastify/static`, which has open path-traversal advisories, so it was removed. `GET /docs/json` is the real output. `ENABLE_API_DOCS` is refused in production (and logs a warning saying so).
- **@fastify/websocket hands the handler the `ws` WebSocket itself** (`handler.call(this, socket, request)`). A `ws@8` server-side socket has **no** `.socket` property — verified against the installed runtime — so `connection.socket` is `undefined` and every later `send`/`close`/`on` throws. Use `connection` directly. The `/ws` tests pass the fake socket as the first argument with no nested `.socket` specifically so this cannot regress.
- Migrations must be applied with `npx prisma migrate deploy` as an explicit step — never assume a migration in the migrations folder is actually applied to the live database; verify with `npx prisma migrate status` when in doubt.
- **`npm run verify:migrations` applies every migration to a real, empty PostgreSQL and diffs the result against `prisma/schema.prisma`.** It exists because a `@@index` in the schema is only a *claim*: `RampTransaction @@index([status])` was declared from the start and no migration ever created it, so production ran status queries unindexed. `prisma/schema.prisma` and `prisma/migrations` drifting apart is a real, previously undetected failure mode — run this after any schema edit, not just before release.
- **Under Prisma 7, `prisma migrate diff --from-migrations` does not work in this project**: it demands `datasource.shadowDatabaseUrl`, which `prisma7.config.ts` does not define, so it ABORTS instead of diffing. Use `--from-config-datasource --to-schema prisma/schema.prisma` *after* `migrate deploy` against a freshly-migrated database, which asks the same question. This is what the CI drift step does; the old form made that job error rather than check, and it had never run.
- **A managed Redis needs the pub/sub channel grant, not just the key grant.** Redis 7 scopes channels with `&pattern`, separate from `~pattern`, so a user with only `~ulmara:*` can access NO channels and `src/websocket/emit.ts` fails with `NOPERM No permissions to access a channel` while every health check stays green. The app needs `~ulmara:* ~bull:* &ulmara:* &bull:*`. Likewise, `rediss://` with a private CA is refused unless `NODE_EXTRA_CA_CERTS` is set **before the process starts** (Node caches its trust store on first use, so setting it at runtime silently does nothing). `npm run verify:redis:tls` proves all of this against a real TLS+ACL Redis. See OPERATIONS.md "Managed Redis: TLS and ACL".
- **BullMQ workers run in a SEPARATE process** (`src/worker/index.ts`, `npm run start:worker`). `src/server/server.ts` must never import a worker module; the API does not consume queues. Cross-process real-time events go over Redis pub/sub (`src/websocket/emit.ts`) and the API forwards them to that user's sockets only.
- Verification codes live in Redis, not process memory, and only a keyed HMAC of the code is persisted. The code's validity is `OTP_TTL_SECONDS`; the Redis record is retained longer (`+ OTP_EXPIRY_GRACE_SECONDS`) only so a late submit can be answered "expired".
- **Signing out must call `POST /api/auth/logout`, or the token stays live.** The client's logout is purely local — it wipes the token from the device keystore — so nothing told the server the session was over. `requireAuth` treats the `Session` row as the source of truth, so the token kept authorising requests for the full `JWT_EXPIRES_IN` (7 days by default) after the user believed they had signed out. Measured live before the route existed: after a local-only logout the same token still answered 200 on `/api/account/me`, `/api/transaction` and `/api/contact`, and still created a payment request. `DELETE /api/auth/me` was the only server-side way to end a session and it deletes the account, so signing out used to cost the user their account. The route revokes **only** the calling session (deleted by `token`, never by `userId` — a test asserts the predicate), takes no body, and is not rate limited because it only ever shortens the caller's own access. **If you add another way to end a session, delete the row; do not just clear a field.**
- Secrets are read from `env` at boot. `JWT_SECRET` is the current key and the only key new tokens are signed with; `JWT_PREVIOUS_SECRET` + `JWT_PREVIOUS_SECRET_RETIRE_AT` implement zero-downtime rotation. Never log a PIN, PIN hash, JWT, seed, private key or provider credential — `config/sentry.ts` scrubs credential-shaped keys, and there are tests asserting this.
- Email and the NGN ramp each sit behind a provider interface (`src/services/email/`, `src/services/ramp/providers/`). Adding a provider must not require editing the business logic that calls them.

- **Every request body is validated by a `strictObject` schema, and every path/query value is validated too** (`src/utils/requestSchemas.ts`). Never read `request.params`/`request.query`/`request.body` through a bare `as` cast — that has no runtime effect, and the audit in the hardening pass found it had let non-UUID ids and unbounded `?limit=` values reach Prisma. Use `idParamSchema`, `accountIdParamSchema`, `chainParamSchema`, `referenceParamSchema`, `paginationQuerySchema`, `signedTxSchema`, `registerWalletsSchema`, `settingsSchema`.
- **Declare a request body in this module, not as a local `const` in the controller.** `ROUTE_DOCS` in `openapi.ts` needs the schema to publish a `requestBody`, and it cannot import a controller: that would pull Prisma and Redis into `openapi.test.ts` / `openapiRoutes.test.ts`, which run without either. A body defined beside its handler is therefore invisible to the spec — which is why only 2 of 47 operations used to publish one, and why clients had to hand-audit contracts against a running server. Move it here, import it in the controller, and add the `body:` entry. The spec now publishes 23, and `openapi.test.ts` asserts no GET/DELETE declares a body and that every body-taking route has one.
- **`.optional()` and `.nullable()` are different instructions and the distinction is load-bearing.** Absent key → the client did not mention it, so write nothing. Present and `null` → clear it. `settingsSchema` uses `.nullable().optional()` for `name`, `photoUrl` and `defaultNetwork` because those are nullable columns on `User` (`name String?`, `photoUrl String?`, `defaultNetwork Chain?`) and `GET /api/account/me` already returns `null` for them — before that, a client could set a value but never remove one and `""` was refused too, so the unset state was unreachable through the API even though 5 of 6 rows sat in it. `defaultCurrency` and `defaultLanguage` are `String @default(...)` and deliberately stay non-nullable: they have no unset state to return to. **When a schema field maps to a nullable column, ask how a client clears it; if there is no answer, the schema is wrong.**
- **Ulmara is non-custodial, and that is settled — do not "helpfully" add server-side key storage.** The client generates every key on the device (`lib/keyGeneration.ts` in `avora-frontend`: bip39 mnemonics, one derivation path per chain), signs on the device (`lib/signing/`), stores the phrases in the device keystore, and registers only **public** addresses here via `POST /api/wallet/register`. `createAccountId` creating no `Wallet` rows is deliberate. **Never generate, request, receive, store, log or forward a private key or mnemonic** — server-side custody would invert the product's promise, put every user's funds behind this service, and put a seed phrase in a database and a log pipeline. `config/sentry.ts` scrubs `mnemonic`/`privateKey`/`seed` from captured payloads, and there are tests asserting it. Transfers keep keys on the device *by construction*: `external/prepare` persists an intent and returns nothing that can sign, and `/:id/submit` takes an already-signed transaction and verifies it against that intent. There is no code path from this service to a signature. A stale comment in `account.service.ts` once said the custody design was undecided; it had been decided, and the wording invited exactly the wrong change. If you read anything here that suggests custody is an open question, it is stale — check the client before believing it.
- Use `strictObject` (from `src/utils/requestSchemas.ts`), not zod's `.strict()`. zod v4's `ZodObject.strict()` does not type-check on the inferred object type in this project ("Property 'strict' does not exist"). `strictObject` delegates to `z.strictObject` and behaves identically.
- **On an authenticated route, the identity comes from `request.userId` only.** Never accept a `userId` in the body for an authenticated endpoint: the verification routes used to, which let a caller complete verification for an arbitrary account id. `requireAuth` sets `request.userId` from the session row; the body is for data, not identity.

## Testing
CI runs `npm run lint` + `npm run typecheck` + `npm test` on every push/PR to main, plus a migration-drift job that asserts the schema and `prisma/migrations` agree and that every migration applies to an empty database. Keep this green — do not merge or consider a task complete if CI would fail. `npm run verify:all` is the same gate locally.

Two suites need real infrastructure and are part of `npm test`, so CI's Redis service covers them:
- `src/load/` — concurrent load tests for the rate limiter and the PIN lockout (`npm run test:load` for a verbose run). They set `TRUSTED_PROXIES` in a `vi.hoisted` block, so they behave identically under `npm test` and under the script; do not move that into the shell wrapper.
- `src/services/auth/verificationCodeStore.test.ts` — real Redis (EX TTL, Lua).

The suite includes a **real-Redis integration suite** for the OTP store, so `REDIS_URL` must point at a running Redis in CI (a `redis` service container is defined in the workflow). Tests that write to the database are excluded; anything needing a live DB belongs in a probe script under `scripts/`, not the unit suite.

## Toolchain facts (these bite; check before "fixing" a lint or build error)

- **`npm run lint` is ESLint, not `tsc`.** It is a flat config (`eslint.config.js`) using `@eslint/js` recommended + `typescript-eslint` **type-aware** presets, run with `projectService: true`. Do not swap `projectService` for a `project: [...]` array: a fresh TS program per file takes a full run from ~15s to ~30 minutes.
- **TypeScript is pinned to 6.x on purpose.** `typescript@7` (the native Go port) exposes no classic compiler API — `require("typescript")` resolves to `lib/version.cjs` and `ts.createSourceFile`/`ts.SyntaxKind` are `undefined`. `typescript-eslint` declares `typescript` as a **peerDependency** (`>=4.8.4 <6.1.0`), and npm cannot nest a peer, so TS 7 and typescript-eslint are mutually exclusive. Do not bump TypeScript to 7 without re-checking this.
- `scripts/` and the root `*.ts` config files are linted **without** type-aware rules. `tsconfig.json` includes only `src` (widening it would change what `tsc -p` emits into `dist/`), so those files belong to no TS project and the project service cannot resolve them. `allowDefaultProject` and `defaultProject` were both tried and both made lint non-deterministic. Application code under `src/` is fully type-aware.
- **Three rules are relaxed in narrowly-scoped config blocks**, each with a written reason: `return-await` in `src/controllers/**` (the Fastify `return reply.send()` idiom), `require-await` in `src/chains/**` and `**/*.test.ts` (interface/mock signature conformance), `unbound-method` in `src/routes/**` and `**/*.test.ts` (route registration + `vi.spyOn`). These are scoped, not global — do not widen them without checking the specific finding.
- **`@types/ws` must stay on the same major as the installed `ws`.** A mismatched `@types/ws` makes `connection.socket` resolve to an unresolvable type and hides a real runtime break (see the WebSocket note below).
- `isUniqueConstraintViolation` (`src/utils/prismaError.ts`) is the single place that checks Prisma's `P2002`. Do not re-open-code `(err as { code?: string }).code === "P2002"` or use `catch (err: any)`.
- **All money <-> base-unit conversion goes through `src/utils/money.ts`** (`toBaseUnits` / `fromBaseUnits`). Never `Number(amount) * 10**d`, `Math.round(...)`, or `String(base / 10**d)` — those lose real value. `moneyString()` is the request-level schema; use it for every amount rather than a hand-rolled `z.string().regex(...)`. The two exceptions are the vendor SDK boundaries, both commented in place: `tronweb`'s `sendTrx` takes a `number` (so amounts above 2^53 sun are **refused**, not truncated), and Solana/Tron balance *reads* come back from the SDK as `number` (a 2^53 ceiling we cannot lift). TON returns a `bigint` and has no such limit.
- `verifySignedTransaction` (`externalTransferService`) is **synchronous** on purpose: it inspects an already-signed transaction and performs no I/O, so it throws rather than rejecting. Tests use `captureThrow` to assert the throw.
- `registerHealthRoutes`, the `*.routes.ts` plugin functions and `registerWebsocketHandlers` are **not** `async` — they only register routes. `app.register()` accepts a sync plugin.
- Sentry is `@sentry/node@11`, which **removed** `sendDefaultPii` in favour of an explicit `dataCollection` block whose defaults are permissive (bodies, cookies, query params, DB params are all collected). `initSentry` sets every collector to off explicitly; never "simplify" that block back to the SDK default.


## Environment gotchas (bit me; check before debugging elsewhere)

### Run `npm run verify:env` before booting anything that touches the database

Four mistakes below are now enforced mechanically by `scripts/verify-env.sh` (wired as `npm run verify:env`). Run it before starting the API, the worker, or a probe script. It refuses, with a non-zero exit:

| it refuses | because |
|---|---|
| an unset `DATABASE_URL` | nothing can be verified |
| a **remote** host (Neon, any `*.neon.tech`) | a typo silently points disposable work at production. Override deliberately with `ALLOW_REMOTE_DATABASE=1`. |
| **port 5434** | that is `avora-fe-pg`, a Postgres container that was **shared with another project**. It is stopped. Starting it again re-creates the exact condition below. |
| **port 5433** | held by another project's container (`unimap-db`). This is why `verify:migrations` used to fail here — it is now `PG_PORT`-overridable instead. |
| a database with **0 applied migrations** | see the outage below |

- **The 2026-10-03 outage, and the reason this script exists.** The disposable database pointed at `avora-fe-pg`, which was also serving another project. That project's harness ran `DROP DATABASE IF EXISTS carbon_trace; CREATE DATABASE carbon_trace;` against the shared server and `ulmara_fe_test` went with it. Every Prisma-backed endpoint returned **500 for seven hours** with `relation "public.User" does not exist`, while `/health/ready` reported `database: ok` the entire time. **The mistake was not a code bug — it was pointing at infrastructure another process could destroy.** Ulmara now has its own container, `ulmara-pg` on **5435**; `avora-fe-pg` is stopped, not deleted.
- **`SELECT 1` does not prove the schema exists.** It succeeds against a completely empty database, which is why the outage above was invisible to every monitor. `GET /health/ready` now runs a second query against `_prisma_migrations` and reports a separate `schema` check; `/health` stays dependency-free on purpose (a load balancer restarting the process would not fix an un-deployed schema).
- **A test must only delete state it created.** `src/load/rateLimit.lockout.load.test.ts` once called `redis.flushdb()`, which reset nothing it owned (the limiter is in-memory via `LocalStore`; the PIN lockout is Prisma-backed) while wiping every other suite's keys **and** the running dev API's pending verification codes. It produced a ~1-in-4 flake that looked like a code fault and was pre-existing. The same rule applies to `SCAN`+`DEL`: `verificationCodeStore.test.ts` scanned the bare `ulmara:otp:*` and deleted other runs' keys; its own keys are namespaced per run, so the pattern must include that namespace. **Never `flushdb`/`flushall`, and never delete by a pattern you did not namespace.**
- **In WSL, bare `npx` and `node` are not what you expect.** `npx` resolves to the *Windows* `npx.exe` and fails with `CMD.EXE was started with the above path as the current directory. `node` is absent from a non-login shell. Use `./node_modules/.bin/<tool>`, and `source ~/.nvm/nvm.sh` first when scripting.
- **Never keep a durable file under `%TEMP%`.** An env file holding `RESEND_API_KEY` was lost to Windows temp cleanup and took the key with it. `~/dev/ulmara-fe-backend.env` is the live one; `dotenv` does not override exported variables, so `set -a; source …; set +a` wins over the repo `.env` by design.
- With WSL2 **mirrored** networking (`/etc/wsl.conf` → `networkingMode=mirrored`), hosts that publish AAAA records can present an IPv6 address that is advertised but not routable. `src/config/database.ts` calls `net.setDefaultAutoSelectFamily(false)` at module load to stop Node's Happy-Eyeballs connect from failing with a bare `AggregateError [ETIMEDOUT]` even when IPv4 works. Do not remove that call.
- **Always identify which Redis you are talking to before trusting a measurement.** A systemd `redis-server` inside WSL used to bind `127.0.0.1:6379` and silently shadow the `avora-redis` container for anything launched in WSL; it was stopped and disabled. A **second, non-systemd native `redis-server` was later found doing the same thing** (started by hand, `dir` pointing at `/home/biggestmanuel/dev`, `appendonly no`, exit-255-prone). It has been killed. Confirm identity with `redis-cli INFO server | grep process_id` — the container always reports **`process_id: 1`**; a native process reports its own PID. `executable` pointing outside the container is the second tell. Until this is right, every Redis measurement (OTP suite included) is measuring the wrong server.
- `avora-redis` is now **compose-managed**: `docker compose up -d` / `npm run verify:redis`. A `docker compose restart` in this environment sometimes does not materialise the host port proxy, leaving `NetworkSettings.Ports` empty; a plain `docker restart avora-redis` re-establishes it. Always confirm `process_id: 1` after touching the container.
- `docker` works from **inside WSL** here (`/usr/bin/docker` + `/var/run/docker.sock`), so the Redis verification script runs under WSL alongside `redis-cli` and `npx`. `sudo` needs a password; `wsl -d Ubuntu -u root -- <cmd>` works for root actions.
- WSL itself crashed once mid-session (`0x8007274c`), which killed the Docker VM and left the Redis container `Exited (255)` with no log line and **no port binding**. If Redis is mysteriously unreachable, check `docker ps -a` before assuming a code bug.
