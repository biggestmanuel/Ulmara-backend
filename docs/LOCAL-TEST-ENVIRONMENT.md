# Ulmara backend — live test environment

> **This file is the versioned copy.** It previously lived at
> `~/dev/ULMARA-FE-HANDOFF.md`, which is outside every git repository — so it was
> untracked, invisible to `git status`, and one directory cleanup away from
> being lost entirely. Keep it here.
>
> It describes a THROWAWAY local environment: disposable accounts, testnet
> balances, and a disposable Postgres container. None of it is production, and
> nothing in it is a real credential. For the parts that apply to a real
> deployment, read `OPERATIONS.md` instead.


Everything the frontend session needs to test against a real running backend.
Originally written 2 Oct 2026; **last verified 3 Oct 2026 against commit
`323b416`** (branch `hardening-2026-09-30`, CI green, pushed).

---

## 1. Where it is

```
From this machine (WSL, or Windows via loopback):  http://127.0.0.1:4100
From a phone on the same WiFi:                    http://<your-LAN-IP>:4100
```

**Not port 4000.** A Windows `svchost` (the WSL/Hyper-V networking relay) already
holds `0.0.0.0:4000`. WSL's `ss` cannot see Windows listeners under mirrored
networking, so this only appears as `EADDRINUSE` when the server tries to bind.
Nothing was killed; the backend uses 4100 instead.

### ⚠️ Run `npm run verify:net` before testing from a phone

The LAN address is assigned by DHCP and **it changes.** This machine was
`192.168.1.9` and is now `192.168.1.5` again. Every address that has to be
written down by hand — the frontend's `EXPO_PUBLIC_API_BASE_URL`, the CORS
allowlist — was pointing at the old one, so the app would have failed with a bare
*"Network request failed"* and no hint why.

`npm run verify:net` checks all of it in one shot: the current LAN address, that
the API is bound to `0.0.0.0` (so the LAN is covered at all), that it answers on
that address, whether Windows has an inbound firewall rule for the port, and
whether the frontend and the CORS allowlist agree with the address the machine
actually has. It exits non-zero and prints the exact command to run.

`EXPO_PUBLIC_*` values are **inlined into the bundle at build time**, so restart
Expo after changing the `.env` or it keeps using the old value.

### ⚠️ A phone on the LAN still needs one Windows-side action

**Proven cause, not a guess:** from WSL, `http://192.168.1.5:4100/health` returns
**200**, and the API is bound to `0.0.0.0:4100`, so the socket genuinely covers
the LAN interface. From Windows, `netstat` shows **nothing** listening on 4100
and both `192.168.1.5:4100` and a Windows-side `Invoke-WebRequest` to it time
out — while `127.0.0.1:4100` returns 200. And:

```
Get-NetFirewallPortFilter | Where-Object LocalPort -eq 4100   ->  0 rules
```

**There is no inbound firewall rule for 4100.** A previously-added rule is not
present. Run this once, in an **administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName 'Ulmara API 4100' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4100 -Profile Private
```

No `netsh interface portproxy` is needed: WSL is in **mirrored** networking mode
(`/etc/wsl.conf`), so it shares the host's interfaces and a `0.0.0.0` listener is
already on the LAN. (The stale `4000 → 172.28.24.76:4000` proxy rule is a NAT-mode
leftover and is not what makes 4100 work.)

### Which base URL to use

| Testing on | `EXPO_PUBLIC_API_BASE_URL` |
|---|---|
| Android emulator on this machine | `http://10.0.2.2:4100` |
| Expo web in a browser on this machine | `http://127.0.0.1:4100` |
| A physical phone on the same WiFi | `http://192.168.1.5:4100` (re-check with `npm run verify:net`) |

The CORS allowlist covers all of these origins for the current LAN address
(`http://192.168.1.5:8081`, `:19000`, `:19001`, `:19002`, `:19006`, `:8082`).

## 2. Test accounts

| | |
|---|---|
| Main account | `fe-session-1790966492@ulmara.test` |
| Password | `FeSessionPassw0rd!23` |
| PIN | `123456` (needed for transfers and PIN changes) |
| Account ID | `0957683584` |
| Email verified | yes |
| Second account (send target) | `fe-recipient-1790966858@ulmara.test`, same password |
| Second Account ID | `9259531853` |

Both accounts have wallets registered on all 8 chains.

**The main account is at its pre-audit baseline**, verified by reading the row
directly: `name` "Fe Ada", `photoUrl` null, `defaultNetwork` null,
`defaultCurrency` NGN. If you change it, that is your business — but it was
restored deliberately, so please do not assume a dirty value is a bug.

## 3. Health checks

```bash
curl -s http://localhost:4100/health         # process alive
curl -s http://localhost:4100/health/ready   # ALSO checks the DB and Redis really work
curl -s http://localhost:4100/docs/json | head -c 200   # live API spec, 47 operations
```

All three verified 3 Oct: 200 / 200 / 47 operations.

## 4. What is running

| Process | Log |
|---|---|
| API (`src/server/server.ts`) | `/tmp/ulmara-fe-backend.log` |
| BullMQ worker (`src/worker/index.ts`) | `/tmp/ulmara-fe-worker.log` |

The worker is a **separate process on purpose** — a crash there must never take
the HTTP surface down. Without it, transactions sit at `PENDING` forever.

```bash
# is it still healthy?
grep -cE '"level":(50|60)' /tmp/ulmara-fe-backend.log   # 0 = no server errors
tail -f /tmp/ulmara-fe-backend.log
```

## 5. Infrastructure (all disposable — nothing touches production)

| | |
|---|---|
| Postgres | container **`ulmara-pg`**, port **5435**, db `ulmara_fe_test`, **9 of 9 migrations applied** |
| Postgres (old) | `avora-fe-pg` on 5434 is **STOPPED** — see the outage note below. Do not restart it. |
| Redis | your `avora-redis` on 6379, but **database 1** so it won't collide with db 0 |
| Chains | **testnet** — Sepolia, BSC testnet, Base Sepolia, Polygon Amoy, Solana devnet, Tron Shasta |
| Live Neon | **never touched.** `DATABASE_URL` and `DIRECT_URL` both point at 5435 |

### Restart after a Docker/WSL restart

⚠️ **Use the env file in `~/dev`, not a temp directory.** An earlier copy lived
under `%TEMP%\opencode` and was destroyed by Windows' temp cleanup, taking the
`RESEND_API_KEY` with it. Never put a durable artefact there again.

```bash
docker start ulmara-pg
cd ~/dev/avora-backend
set -a; source ~/dev/ulmara-fe-backend.env; set +a
export DEV_VERIFICATION_MODE=true
setsid ./node_modules/.bin/tsx src/worker/index.ts  >> /tmp/ulmara-fe-worker.log  2>&1 < /dev/null & disown
setsid ./node_modules/.bin/tsx src/server/server.ts >> /tmp/ulmara-fe-backend.log 2>&1 < /dev/null & disown
```

Two traps in that command, both hit for real:

- **Use `./node_modules/.bin/tsx`, not `npx tsx`.** Inside WSL a bare `npx`
  resolves to the *Windows* `npx.exe`, which fails with
  `CMD.EXE was started with the above path as the current directory. UNC paths
  are not supported.` The same applies to `node` itself, which is absent from a
  non-login WSL shell — `source ~/.nvm/nvm.sh` first if you script this.
- **`DEV_VERIFICATION_MODE` is not in the env file.** It is exported per-process
  above, so it silently reverts to off after any restart.

### `npm run verify:migrations` will fail — and that is not your fault

Port **5433** is held by `unimap-db`, a container belonging to another project.
The rehearsal script hardcodes `PG_PORT=5433` and cannot bind it, so its own
throwaway Postgres never starts and it reports *"PostgreSQL never became ready"*.

That is a port collision, not schema drift. Run it on a free port instead:

```bash
sed -i 's/^PG_PORT=5433$/PG_PORT=5435/' scripts/verify-migrations-rehearsal.sh
npm run verify:migrations      # → MIGRATION REHEARSAL PASSED
git checkout scripts/verify-migrations-rehearsal.sh   # revert; never commit this
```

Verified 3 Oct: **PASSED**, empty schema/migration diff. Do not "fix" this by
stopping `unimap-db` — it is not ours.

## 5b. ⚠️ The 2026-10-03 outage — and why the container changed

Every Prisma-backed endpoint returned **500** for ~7 hours. Not a code bug: the
test database had been **emptied**.

The cause is in the Postgres log, not the app log:

```
23:27:53  ERROR: DROP DATABASE cannot run inside a transaction block
23:27:53  STATEMENT: DROP DATABASE IF EXISTS carbon_trace; CREATE DATABASE carbon_trace;
23:27:58  FATAL: database "carbon_trace" does not exist
```

Another project's test harness ran a reset script against `avora-fe-pg`, which
was doubling as a shared Postgres server for two projects. `ulmara_fe_test` went
with it. The app-side symptom was `The table public.Session does not exist`, and
`/health/ready` still reported **database ok** — because `SELECT 1` succeeds
against an empty database. Health checks cannot detect this.

**What changed, so it cannot recur:**

| | before | now |
|---|---|---|
| container | `avora-fe-pg` (shared) | **`ulmara-pg`** (this project only) |
| port | 5434 | **5435** |
| state | running | `avora-fe-pg` **STOPPED**, not deleted |

`avora-fe-pg` must not be restarted. If you need the old data back, it is still
in that container's volume.

**⚠️ Account IDs changed** because the database was rebuilt from migrations. The
old rows could not be recovered, so the current values are new ones. If your
client has an Account ID hardcoded, check it against section 2.

## 6. Email: codes are available, but real mail is not

`DEV_VERIFICATION_MODE=true`, so signup returns the code directly:

```json
{ "data": { "devVerificationCodes": { "email": "123456" } } }
```

It is also written to the log. This was broken before (B1) — signup returned 503
with no code.

⚠️ **This is a development convenience I control, not a contract.** Do not code
against `devVerificationCodes` as though it will always be there.

### ⚠️ A brand-new email address cannot receive a real verification email

The sender is Resend's `onboarding@resend.dev`, which can only deliver to **the
account owner's own address**. Any other recipient gets nothing — not spam,
nothing. Mail that does go out lands in **spam**, because there is no matching
SPF/DKIM for an unowned domain.

So: real users cannot be emailed at all until a domain is bought and verified.
Both self-resolve with the domain; neither is a code defect. Until then, OTP
testing goes through `devVerificationCodes`, and the address you sign up with
must be one that can actually receive mail.

## 7. API shapes the frontend must match

These were all verified live. Getting a field name wrong returns a clear 400,
so these are safe to code against.

**Verification bodies** (no `userId` anywhere — identity comes from the token):

```jsonc
POST /api/auth/verify-email   { "code": "123456" }
POST /api/auth/verify-phone   { "code": "123456" }
POST /api/auth/resend-code    { "channel": "email" }
```

### ⚠️ PINs: `set-pin` is first-time only, `change-pin` replaces

**Changed in `bffceae`.** `set-pin` used to overwrite an existing PIN with no
`409` and no current-PIN check, which meant anyone holding only a session token
could replace your PIN and then pass the transfer gate with it. Fixed and
verified live. **This is a breaking change for your client:**

```jsonc
POST /api/auth/set-pin    { "pin": "123456" }
  → 200 first time
  → 409 "A PIN is already set for this account"  once one exists

POST /api/auth/change-pin { "currentPin": "123456", "newPin": "654321" }
  → 200   the ONLY way to replace a PIN; requires the current one,
          limited to 5/min, and counts toward the shared lockout
```

So: if your "set PIN" screen can be reached when a PIN already exists, it must
call `change-pin` instead — or branch on the 409. Sending `{ pin }` to
`set-pin` as a way of *changing* the PIN will now always fail.

`set-pin` is also rate limited to **5/min**, shared with `change-pin`. Verified
live: nine calls on a PIN-less account give
`200 409 409 409 409 429 429 429 429`. The `409`s are decided before the bcrypt
hash runs, so only the first call pays for it.

Verified after the fix, live: overwrite → `409`; the genuine PIN still verifies
`200`; the rejected candidate is `401`; a transfer using it is refused; four
replays all `409`; `change-pin` still works.

**Wallets** — note the key is `addresses`, not `wallets`:

```jsonc
POST /api/wallet/register
{ "addresses": [ { "chain": "ETH", "address": "0x…" } ] }
```

⚠️ **All 8 chains are mandatory.** Sending only ETH gives:

```
400 "Missing address(es) for required chain(s): TON, BSC, SOL, BASE, POLYGON, TRON, BTC"
```

Address formats the server enforces: EVM `0x`+40hex · SOL base58 32–44 ·
TRON `T`+33 · TON exactly 48 base64url · BTC base58 or bech32.

**Transactions use `network`, not `chain`** — this differs from every other
endpoint and is an easy mistake:

```jsonc
POST /api/transaction/fee
{ "recipientAddress": "0x…", "asset": "ETH", "amount": "0.001", "network": "ETH" }

POST /api/transaction/send
{ "recipientAccountId": "9259531853",   // XOR recipientAddress, exactly one
  "asset": "ETH", "amount": "0.01", "network": "ETH",
  "pin": "123456", "idempotencyKey": "<uuid v4, required>" }
```

⚠️ **Sending to your own Account ID is refused** with
`400 Cannot send to your own Account ID`. Use the second account as the target.

⚠️ **`send` is rate limited to 10 per minute per user.** Over that: `429`. Do not
let a retry loop re-fire it.

⚠️ **Reusing an `idempotencyKey` with different parameters** gives
`409 This idempotency key was already used for a different transfer`. A retry
must reuse the **same key and the same parameters**; only that replays the
original row.

**Two-phase transfer** — this is the important one:

```
1. POST /api/transaction/send          → 201, status PENDING  (nothing is queued yet)
2. POST /api/transaction/:id/broadcast → 200, status PROCESSING (NOW it is queued)
3. worker signs nothing — it broadcasts → COMPLETED or FAILED
```

A transaction stuck at `PENDING` is **normal**, not a bug: it is waiting for
step 2. `idempotencyKey` makes a retried send replay the original row instead of
creating a second transfer — verified live, the same key returned the same
transaction id.

### ⚠️ `broadcast` takes `signedTx` and nothing else

```jsonc
POST /api/transaction/:id/broadcast
{ "signedTx": "0x02f872…" }        // ONLY this key
```

Sending `idempotencyKey` as well is a **400**: `input: Unrecognized key:
"idempotencyKey"`. The schema is strict. `signedTx` must be at least 16
characters — a short placeholder is rejected with *"A serialized signed
transaction is required"*, which is a **different** error and an easy one to
misread as the key problem.

**Broadcast is retry-safe with no key at all**, so a retry after a lost response
needs no special handling. Measured on a *fresh* `PENDING` row:

```
broadcast #1 → 200  PROCESSING
broadcast #2 → 200  PROCESSING
broadcast #3 → 200  PROCESSING
→ 3 broadcasts, the worker ran exactly 1 job
```

That is an atomic `PENDING → PROCESSING` claim (`updateMany` with
`status: "PENDING"` in the `where`), so only the first caller can enqueue.

Once the worker has settled the row, broadcasting again is **`409 Transaction is
no longer awaiting broadcast`**. That is a correct refusal, not an error state —
but `friendlyError`'s per-status copy will render it, so be aware it can look
alarming.

**External wallet transfers** (client signs locally):

```jsonc
POST /api/transaction/external/prepare
{ "chain": "ETH", "asset": "ETH", "amount": "0.001", "to": "0x…", "pin": "123456" }
→ 201 { "id": "<intentId>", "fee": "0.00003954096174", "status": "READY" }

POST /api/transaction/external/:id/submit
{ "signedTransaction": "0x…", "idempotencyKey": "<uuid>" }
```

**Ramp** — `amountNgn`, not `amount`:

```jsonc
POST /api/ramp/deposit  { "amountNgn": "5000" }
POST /api/ramp/withdraw { "amountNgn": "5000", "accountNumber": "0123456789",
                          "bankCode": "058", "accountName": "…" }
```

⚠️ Both currently return **503** because there are no Bitnob/YELLOW_CARD
credentials in this environment. It is a clean 503, not a crash, and the message
now names the real reason — `Naira deposits are temporarily unavailable. Please
try again shortly.` (it used to be the generic *"Something went wrong. Please
try again."*; that was the `HttpError`-message fix).

**Token balances** — `chain` is **case-sensitive and UPPERCASE**:

```jsonc
GET /api/wallet/token-balances?chain=ETH&address=0x…
// chain=eth → 400
```

A chain that cannot be reached yields an **empty list, not an error**. TON
returns `[]` here. Rows carry `symbol`, `name`, `chain` (lower-case ChainId),
`network` (UPPERCASE), `decimals`, `contractAddress`, `balance` (exact decimal
string).

**This endpoint works and returns live balances.** `lib/api/tokens.ts` in the
frontend still carries the comment *"The backend does not implement it today, so
balances are read with one `eth_call` per token"* and falls back to direct RPC.
Verified live on `ETH`, `BSC` and `SOL` — all `200` with real balances. The
frontend's own `TokenBalance` type already matches the response exactly, so
switching it over is a deletion, not a rewrite.

### Errors are always `{ "success": false, "message": "…" }` — including a 404

Every error the frontend can receive, in one shape. That matters because
`lib/api/client.ts` **only shows the server's message when the body is exactly
`{ success: false, message }`**; anything else is replaced with generic per-status
copy.

```jsonc
{ "success": false, "message": "Incorrect PIN. Try again." }
```

A router 404 used to break this rule — Fastify's router rejects an unmatched path
itself, so it never reached the error handler and answered `{ "message": "Route
GET:/x not found", "error": "Not Found", "statusCode": 404 }` with no `success`
key. A typo'd path, and a wrong verb on a real path, both reached the user as the
generic *"Not found. Please check the details and try again."* **Fixed:** every
404 now uses the envelope, e.g.
`{"success":false,"message":"Route GET:/api/auth/login not found"}`.


## 8. ⚠️ `GET /api/account/me` returns accountId as an OBJECT

```jsonc
{ "data": { "accountId": { "id": "…", "accountId": "0957683584",
                           "userId": "…", "createdAt": "…" } } }
```

The 10-digit string is at **`data.accountId.accountId`**, not `data.accountId`.
Treating it as a string yields `{"id": "9ca36a0a…` truncated — the
`[object Object]` trap.

**This is confirmed correct and is not changing.** The frontend reads it
correctly (`me?.accountId?.accountId` in both `login.tsx` and
`create-account-id.tsx`) and now types it via `MeProfile`/`MeAccountId`. It
stayed this way because it was outside the agreed B1–B9 scope.

One residual risk worth knowing: `userStore.hydrate()` never reads `.accountId`
(it uses SecureStore), and `login.tsx` writes the value straight into storage. A
future regression to a string shape would put `"{'id': '9ca36a0a…"` into the
user's Account ID slot with nothing failing.

## 9. Settings: omitting a key is not the same as clearing it

`PATCH /api/account/settings` — fixed in `323b416`.

| you send | what happens |
|---|---|
| key absent | that column is left alone — no write |
| key present, `null` | that column is set back to `NULL` |
| `""` | **400** — there is no empty-string back door |

```jsonc
PATCH /api/account/settings
{ "name": null, "photoUrl": null, "defaultNetwork": null }   // → 200, all three cleared
PATCH /api/account/settings {}                                // → 200, nothing changed
```

`name`, `photoUrl` and `defaultNetwork` are nullable **columns**, and
`GET /api/account/me` already returns `null` for an unset one — so `null` is the
normal state, not an edge case. Before this fix a client could set a value but
never remove one: 5 of 6 rows in the test database were NULL purely because they
were *created* that way, never because the API cleared it.

`defaultCurrency` and `defaultLanguage` still **reject** `null` with a 400 — they
are `String @default("NGN")` / `@default("en")` and have no unset state.

So `defaultNetwork: string | null` in the frontend patch type is **exactly
right**. Keep it. Clear with explicit `null`, never `""`.

## 10. Known issues, ranked

**1. Real users cannot receive any email.** See section 6 — no domain, and
`onboarding@resend.dev` only delivers to the account owner. Blocks real-user
signup testing. **Blocked on buying a domain**, not on code.

**2. Ramp returns a 503 with no provider behind it.** The status and the message
are now both right (*"Naira deposits are temporarily unavailable. Please try
again shortly."*); the log carries `ramp_provider_unavailable`. Blocked on
Bitnob/YELLOW_CARD credentials.

**3. TON and BTC balances are `null`.** TON: no reachable public testnet RPC
from this host. BTC: no `BTC_RPC_URL`, and the adapter raises
`ProviderUnavailableError` **by design** — that is not a bug to fix.

⚠️ **This is the most dangerous item for your UI.** A balance screen that renders
`null` as `0.00` looks *correct* and is lying. Show "unavailable".

**Resolved since the first version of this doc:** the BSC / BASE / POLYGON
chain-ID bug is **fixed** (`a4e54fa`, +8 tests). Those three adapters omitted
`createEvmAdapter`'s third argument, so `CHAIN_CONFIG`'s hardcoded mainnet
values (56 / 8453 / 137) were used and `BSC_CHAIN_ID` / `BASE_CHAIN_ID` /
`POLYGON_CHAIN_ID` were ignored. They now route through `getEvmChainId`, proven
live: BSC 4.61, BASE 0.59, POLYGON 7.32 (all previously `null`), chains-with-
balance 3 → 6. ETH, SOL and TRON also return real balances.

**4. TON seed address fails its checksum.** `EQAAAA…` is rejected by
`Address.parse` on some paths. Cosmetic for testing; the registration endpoint
does accept it.

## 11. What is proven working

Everything below was exercised against this running server, not assumed:

- signup → dev code → `verify-email` → `emailVerified: true`
- real Resend delivery end-to-end (`event: email_sent`, provider resend, 0 failures)
- `create-account-id` with `Content-Type: application/json` and no body → 201
- `set-pin` / `verify-pin`; wrong PIN → 401 `Incorrect PIN. Try again.`
- all four PIN-gated paths return **423** while locked, never 401
- `register` for all 8 chains; `GET /api/wallet/addresses` lists them
- `token-balances` → `USDC 27339.201244, decimals 6, chain eth / network ETH`
- fee estimate → real gas: `0.000043592888052` ETH
- internal `send` → 201; **idempotent replay returned the identical transaction**
- `broadcast` → 200 → PROCESSING → **worker picked it up in ~3s** → chain RPC
  rejected the deliberately fake signature → status FAILED, error logged.
  **This proves API → BullMQ → worker → chain RPC → status writeback works.**
- broadcast retried 3× on a fresh row → 3× 200, **1 job**; after settlement → 409
- external `prepare` → 201 `READY` with a real fee; forged `submit` → 400
  `The signed transaction could not be decoded`
- contacts: create, duplicate POST → **409**, `PATCH` rename **preserves the
  contact id**, duplicate PATCH → 409, bad Account ID → 404 `Account ID not found`
- payment request: note trimmed, `symbol`, `requesterAccountId`,
  `requesterName` present, **0** leaks of userId/email/phone
- CORS preflight advertises GET, HEAD, POST, PATCH, DELETE, OPTIONS; 12 LAN and
  emulator origins allowed
- settings: set → clear-by-null → omit-one-key round trip, **verified by reading
  the database row directly**, not just the HTTP reply

## 12. Repository state

| | |
|---|---|
| Backend branch | `hardening-2026-09-30` at `49abfe1`, **pushed**, both CI jobs green |
| Backend `main` | untouched at `0aa0250` — nothing merged |
| PR | #1 open, green on every pushed commit |
| Tests | `npm run verify:all` → exit 0, **50 files / 781 tests** |
| End-to-end | **154 assertions** against the live server on `:4100`, 0 real failures (section 15) |
| Migration rehearsal | PASSED, empty schema/migration diff (`PG_PORT=5436 npm run verify:migrations`) |
| Chain harnesses | `verify:tokens` 3/3 live, `verify:solana` all checks, `verify:providers` 1 verified / 3 skipped for missing credentials |
| Audit | `npm audit` → 0 vulnerabilities |

Frontend side, for reference: `avora-frontend` `main` at `c3428ce`, pushed,
351 assertions green. A read-only conformance audit of all 41 backend paths it
calls is in section 15.

### Backend commits since the fix-phase baseline `8421487` (28)

```
49abfe1 fix(load): a load test was failing on the app's own healthy queue
eb56084 fix(http): answer a router 404 in the same error envelope as everything else
fee21ce fix(env): make the 5434 guard message accurate, and give it a self-test
a26f461 docs: record that request bodies live in requestSchemas.ts
95bfc62 feat(openapi): document the request body of every route that takes one
2008250 test(account): cover the settings service whose contract this pass changed
e6fc5eb chore(env): make verify-env.sh directly executable
8202fd8 fix(health): readiness must prove the schema, not just the socket
c2a932d fix(errors): stop discarding deliberate 5xx messages
9a6394a test(utils): cover the OpenAPI generator, and correct its doc comment
e74971f test: fix a 1-in-4 flake caused by two suites sharing Redis
f1bf200 test: fix two lint/type errors CI caught in the new suites
7758dcc test(jobs): cover the transaction worker, the file that moves money
6840535 test(blockchain): cover address verification, which had none
e918312 docs: record the set-pin and nullable-settings contracts
9c1cf5e fix(deps): fastify 5.12.4 -> 5.12.5 for GHSA-4mh8-r7rc-xpvc
b8a0b86 fix(auth): rate-limit set-pin, and let the rehearsal script move ports
bffceae fix(auth): a PIN can be set once, never overwritten without the current one
323b416 fix(account): let null clear a nullable setting
99053f9 fix(email): stop writing the verification code into the log
a4e54fa fix(chains): BSC, Base and Polygon ignored their configured chain id
85d5150 B8: prove every PIN-gated path answers 423 while locked — no code change
98ee121 B6: give each session token a jti
c52cc35 B5: implement GET /api/wallet/token-balances
e619bfa B4: add PATCH /api/contact/:id, and make a duplicate name a 409
15fbf8b B3: add the payment-request note, and stop leaking userId on the public link
dd280ea B2: treat an empty JSON body as no body, at the parser
3eaac64 B1: make DEV_VERIFICATION_MODE actually bypass the email provider
```

## 13. Still blocked (needs a human, not code)

1. **Domain purchase** — blocks real-user email. `ulmara.com` is taken
   (NameCheap, 2023→2027, transfer prohibited). `ulmara.ng` / `ulmara.app` are
   available. A `vercel.app` domain **cannot** work: Resend cannot verify a
   shared domain.
2. **Ramp credentials** (Bitnob or Yellow Card) — 503 until provided.
3. **TON/BTC RPC endpoints** — TON null is environmental; BTC null is by design.
4. **Firewall rule for phone testing** — section 1.
5. **Merging PR #1 to `main`** — your call, not started.

## 14. Not yet exercised by anyone

- the full OTP flow end-to-end via a genuinely different address (blocked by
  section 6, so use `devVerificationCodes`)
- `/api/ramp/*` beyond confirming the 503
- a real push notification — there is no push route at all (section 15)

## 15. Frontend ⇄ backend conformance audit

Every path `lib/api/*` in `avora-frontend` actually calls, checked against the
live server on `:4100`. **The frontend is in good shape: no broken endpoint, no
wrong field name.** The mismatches are all frontend-side or documentation-side,
and are listed here so nobody re-derives them.

### Verified correct — the frontend already matches

| Thing | Why it was worth checking |
|---|---|
| `POST /api/transaction/send` takes **`network`**, `external/prepare` takes **`chain`** | Two conventions for one concept. The frontend uses each on the right route. |
| `external/:id/submit` takes **`signedTransaction`**, `/:id/broadcast` takes **`signedTx`** | Deliberate asymmetry; `signedTx` on submit is a `400`. |
| `me.accountId.accountId` (nested object) | The `[object Object]` trap — handled. |
| `POST /api/payment/request` → `{ requestId, link }`; the public GET is keyed `id` | The `requestId` is discarded by the pay screen, which uses the router param. Fine. |
| `wallet/register` needs **all 8 chains** | `400 Missing address(es) for required chain(s): …` otherwise. The frontend registers all 8. |
| `external/prepare` needs a **registered wallet on that chain** | `400 You have no wallet on ETH` otherwise. Correct, and the frontend registers first. |
| `POST /api/payment/request/:id/fulfill` **exists** | A `404` for a made-up id is the service, not a missing route. |
| `DELETE /api/contact/:id` works with **and** without a body | The frontend's `{}` is harmless; its comment saying it is required is stale. |
| `PATCH /api/account/settings` with `null` clears, omitting does not | Matches the frontend's `SettingsPatch` exactly. |
| PIN error strings: `Incorrect PIN. Try again.` / `Too many incorrect PIN attempts. Try again in 15 minutes.` | `client.ts` string-matches these two prefixes to tell a dead session from a mistyped PIN. **Rewording either one makes the app log the user out on a wrong PIN.** |
| `GET /api/account/resolve/:accountId`, `GET /api/wallet/tokens/:chain`, `POST /api/auth/forgot-password`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/verify-phone` | All exist and answer correctly. |

### Frontend-side issues (not ours to change — recorded for the FE owner)

1. **No fallback for `EXPO_PUBLIC_API_BASE_URL`** (`lib/api/client.ts:4`). No `??`,
   no default. If the env var is missing, every request resolves against the app's
   own origin and fails with no useful diagnostic.
2. **A doomed push-token POST on every cold start and every logout.**
   `POST /api/push/token` and `DELETE /api/push/token` are `404`. The
   `EXPO_PUBLIC_PUSH_REGISTRATION` flag is declared but not checked at those call
   sites, and the `backendUnsupported` guard only trips *after* the first request.
3. **The user's name can never be set.** `signup` **rejects** `name` and
   `fullName` with `400 input: Unrecognized key`. The only way to set a name is
   `PATCH /api/account/settings { "name": … }`, and the preferences screen only
   ever sends `{ defaultCurrency }`. So the name collected on the signup form is
   collected, validated, rendered — and dropped.
4. **Only the transactions store logs out on a 401** (`stores/txStore.ts`). A 401
   from any other endpoint clears only the in-memory token, leaving the app on a
   stale screen with a SecureStore token still present. There is no refresh token
   and no retry anywhere.
5. **`normalizeTransaction` is duplicated by hand** in `externalTransfers.ts`, and
   it silently defaults `direction` to `'sent'` and `fee` to `'0'` — an inbound
   transfer with no `direction` renders as outgoing, and a missing fee renders as
   a free transfer.

### Backend behaviour that is deliberate, not a bug

- **`defaultCurrency` accepts any 3-letter code** (`"XYZ"` → `200`). It is
  `z.string().trim().length(3).toUpperCase()`, a shape, not an enum. The frontend
  must own the currency list and fall back on an unknown code.
- **The transaction list has no status filter.** `paginationQuerySchema` accepts
  `page` and `limit` only, and it is a strict object, so `?status=COMPLETED` is
  `400 input: Unrecognized key: "status"`. Filtering happens client-side.
- **`POST /api/validation/address` answers 200 for a malformed address** and
  reports `{ "formatValid": false, "exists": false }`. It is a checker, not a
  parser. The `chain` is still strict: `chain: "eth"` is a `400`.
- **An already-verified email makes `verify-email` idempotent** — any code, even
  `000000`, returns `200`. A wrong code on a *fresh* account is
  `400 Invalid or expired verification code` and the account stays unverified
  (checked directly).
- **A wrong PIN is answered before the idempotency key is compared**, so a reused
  key with a bad PIN is `401`, not `409`. Correct order — the credential is never
  skipped.