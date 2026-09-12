# Ulmara — Backend

API and services for the Ulmara wallet: Account IDs, multichain transfers, ramps, WebSocket updates.

## Stack

- Fastify (`@fastify/cors`, `helmet`, `rate-limit`, `websocket`)
- PostgreSQL + Prisma 7 (`@prisma/adapter-pg`)
- Redis + BullMQ for queues/jobs
- Chains: TON, BSC, ETH, SOL, Base, Polygon, TRON
- TriVerify SDK for address validation, ethers.js fallback for BSC/Base
- Auth: JWT (`jsonwebtoken`) + `bcryptjs`
- Logging: `pino` / `pino-pretty`

## Project layout

```
src/
  server/         Fastify app + entrypoint (server.ts)
  routes/         account, auth, payment, ramp, transaction, wallet
  controllers/    request handlers per domain
  services/       business logic per domain (mirrors controllers)
  chains/         per-chain client/signing logic
  blockchain/     shared chain utilities
  queues/         BullMQ queues
  jobs/           background job definitions
  websocket/      real-time connection handling
  middleware/     auth, rate-limit, error handling
  config/         env + app config
  types/, utils/
prisma/
  schema.prisma   User, AccountId, Wallet, Transaction, PaymentRequest,
                  RampTransaction, Session
  migrations/
```

## Setup

```bash
npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

Needs a `.env` (no `.env.example` committed yet) with at least:

```
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
PORT=
NODE_ENV=
TRIVERIFY_API_KEY=
RPC_ETH / BSC / BASE / POLYGON / SOL / TRON / TON=
GAS_SPONSOR_PRIVATE_KEY=
```

## Scripts

```bash
npm run dev              # tsx watch
npm run build            # tsc
npm run start            # run compiled dist
npm run prisma:generate
npm run prisma:migrate
npm run prisma:studio
npm test                 # vitest
```

## Status

- Build unverified outside WSL (Prisma engine download can be blocked on restricted networks) — verify with `npx prisma generate` locally
- OTP: placeholder/any-code bug fixed, now returns 501 when provider isn't configured (stale TODO comment in code still needs removing)
- WebSocket auth: not implemented (TODO in `src/websocket`)
- Paystack integration: not started, placeholder ramp provider only
- ERC-20/USDT support: not implemented (native coins only)

## Notes

- Renamed Avora → Zomavi → Ulmara; package name and startup log now say `ulmara-backend`
- Ramp model (`RampTransaction`) is provider-agnostic (`provider` field) — Bachs is the primary NGN ramp per the frontend env, Paystack/Flutterwave are fallbacks
