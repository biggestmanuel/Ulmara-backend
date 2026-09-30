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

## Verification standard
Every claim of "done" or "working" must be backed by actual test output, not assumption. Report exact test pass/fail counts, not just "tests pass." If you cannot verify something (e.g. no live server/DB in this environment), say so explicitly rather than describing untested code as verified.

## Known architecture facts (verify against current code before relying on these — this section may be stale)

- Chain identifiers are UPPERCASE everywhere on the wire (ETH, BTC, BSC, BASE, POLYGON, TRON, SOL, TON) — this is the established convention across Prisma schema, zod validation, and all controllers. Do not introduce lowercase chain identifiers without checking this is still true.
- PIN authorization is gated through `pinLockoutService` — reuse this for any new PIN-gated flow rather than building parallel logic. Login, transfer and changePin PIN lockouts share one counter/cooldown by design. `recordFailure` refuses to advance the counter while a lockout is already active, so a concurrent burst cannot emit a second `pin_lockout_armed` event for one real lockout.
- External-wallet transfers use a prepare/submit two-step flow with server-persisted, single-use, expiring intents — submit must always verify against the stored intent, never trust client-submitted transaction details directly. For an ERC-20 transfer the signed tx must target the token CONTRACT with `value == 0` and calldata `transfer(recipient, amount)`; the amount is checked at the token's own decimals (BSC's USDT/USDC are 18-decimal, Ethereum's are 6).
- TriVerify (friend's SDK) is used for address/network validation on ETH/BTC/SOL/TRON/SUI/TON/Aptos/Polygon; ethers.js fallback is used for BSC/Base.
- Chain IDs are env-driven (`ETHEREUM_CHAIN_ID`, `BSC_CHAIN_ID`, `BASE_CHAIN_ID`, `POLYGON_CHAIN_ID`) and resolved only through `getEvmChainId` in `src/chains/chain.network.ts`. Never hardcode a chain ID. `src/chains/networks.ts` documents every supported network but is documentation only — the app never reads a chain id from it.
- ERC-20 token metadata lives ONLY in `src/chains/tokens/registry.ts` (plus optional `ERC20_TOKEN_CONFIG` overrides). Business logic must resolve tokens through `resolveToken`/`requireToken`/`listTokens` and must never hardcode an address or a decimals value. Run `npm run verify:tokens` to prove every entry against its live network.
- CORS is allowlist-based via `ALLOWED_ORIGINS` env var — never revert to `origin: true`.
- **`trustProxy` decides whether rate limiting works.** Every limiter keys on `request.ip`, which Fastify derives from `X-Forwarded-For` only when a proxy is trusted (`resolveTrustProxy` in `src/server/app.ts`, driven by `TRUSTED_PROXIES` / `TRUSTED_PROXY_COUNT`). Unset behind a proxy means all users share one budget per route — a single abusive client locks everyone out of `/login`. Never set it to `*` on a directly-reachable app: a client can then forge the header to escape its own limit. `npm run test:load` sets it to the loopback addresses and proves both the sharing and the separation.
- **The OpenAPI document is generated from the live route table** (`src/utils/openapi.ts`), and `verifySpecMatchesRoutes` fails the dev/CI boot if a route is undocumented or a documented route was deleted. Add a route → add a `ROUTE_DOCS` entry, or the build breaks. No OpenAPI *library* is used: `@fastify/swagger-ui` pulls in `@fastify/static`, which has open path-traversal advisories, so it was removed. `GET /docs/json` is the real output. `ENABLE_API_DOCS` is refused in production (and logs a warning saying so).
- **@fastify/websocket hands the handler the `ws` WebSocket itself** (`handler.call(this, socket, request)`). A `ws@8` server-side socket has **no** `.socket` property — verified against the installed runtime — so `connection.socket` is `undefined` and every later `send`/`close`/`on` throws. Use `connection` directly. The `/ws` tests pass the fake socket as the first argument with no nested `.socket` specifically so this cannot regress.
- Migrations must be applied with `npx prisma migrate deploy` as an explicit step — never assume a migration in the migrations folder is actually applied to the live database; verify with `npx prisma migrate status` when in doubt.
- **BullMQ workers run in a SEPARATE process** (`src/worker/index.ts`, `npm run start:worker`). `src/server/server.ts` must never import a worker module; the API does not consume queues. Cross-process real-time events go over Redis pub/sub (`src/websocket/emit.ts`) and the API forwards them to that user's sockets only.
- Verification codes live in Redis, not process memory, and only a keyed HMAC of the code is persisted. The code's validity is `OTP_TTL_SECONDS`; the Redis record is retained longer (`+ OTP_EXPIRY_GRACE_SECONDS`) only so a late submit can be answered "expired".
- Secrets are read from `env` at boot. `JWT_SECRET` is the current key and the only key new tokens are signed with; `JWT_PREVIOUS_SECRET` + `JWT_PREVIOUS_SECRET_RETIRE_AT` implement zero-downtime rotation. Never log a PIN, PIN hash, JWT, seed, private key or provider credential — `config/sentry.ts` scrubs credential-shaped keys, and there are tests asserting this.
- Email and the NGN ramp each sit behind a provider interface (`src/services/email/`, `src/services/ramp/providers/`). Adding a provider must not require editing the business logic that calls them.

- **Every request body is validated by a `strictObject` schema, and every path/query value is validated too** (`src/utils/requestSchemas.ts`). Never read `request.params`/`request.query`/`request.body` through a bare `as` cast — that has no runtime effect, and the audit in the hardening pass found it had let non-UUID ids and unbounded `?limit=` values reach Prisma. Use `idParamSchema`, `accountIdParamSchema`, `chainParamSchema`, `referenceParamSchema`, `paginationQuerySchema`, `signedTxSchema`, `registerWalletsSchema`.
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
- With WSL2 **mirrored** networking (`/etc/wsl.conf` → `networkingMode=mirrored`), hosts that publish AAAA records can present an IPv6 address that is advertised but not routable. `src/config/database.ts` calls `net.setDefaultAutoSelectFamily(false)` at module load to stop Node's Happy-Eyeballs connect from failing with a bare `AggregateError [ETIMEDOUT]` even when IPv4 works. Do not remove that call.
- **Always identify which Redis you are talking to before trusting a measurement.** A systemd `redis-server` inside WSL used to bind `127.0.0.1:6379` and silently shadow the `avora-redis` container for anything launched in WSL; it was stopped and disabled. A **second, non-systemd native `redis-server` was later found doing the same thing** (started by hand, `dir` pointing at `/home/biggestmanuel/dev`, `appendonly no`, exit-255-prone). It has been killed. Confirm identity with `redis-cli INFO server | grep process_id` — the container always reports **`process_id: 1`**; a native process reports its own PID. `executable` pointing outside the container is the second tell. Until this is right, every Redis measurement (OTP suite included) is measuring the wrong server.
- `avora-redis` is now **compose-managed**: `docker compose up -d` / `npm run verify:redis`. A `docker compose restart` in this environment sometimes does not materialise the host port proxy, leaving `NetworkSettings.Ports` empty; a plain `docker restart avora-redis` re-establishes it. Always confirm `process_id: 1` after touching the container.
- `docker` works from **inside WSL** here (`/usr/bin/docker` + `/var/run/docker.sock`), so the Redis verification script runs under WSL alongside `redis-cli` and `npx`. `sudo` needs a password; `wsl -d Ubuntu -u root -- <cmd>` works for root actions.
- WSL itself crashed once mid-session (`0x8007274c`), which killed the Docker VM and left the Redis container `Exited (255)` with no log line and **no port binding**. If Redis is mysteriously unreachable, check `docker ps -a` before assuming a code bug.
