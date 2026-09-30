# Ulmara Backend — Agent Instructions

## Stack
Node/TypeScript, Fastify, PostgreSQL (Neon), Prisma, Redis, BullMQ, WebSockets, REST.
Dev environment: WSL2 Ubuntu, Docker Desktop for Redis.

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

## Verification standard
Every claim of "done" or "working" must be backed by actual test output, not assumption. Report exact test pass/fail counts, not just "tests pass." If you cannot verify something (e.g. no live server/DB in this environment), say so explicitly rather than describing untested code as verified.

## Known architecture facts (verify against current code before relying on these — this section may be stale)

- Chain identifiers are UPPERCASE everywhere on the wire (ETH, BTC, BSC, BASE, POLYGON, TRON, SOL, TON) — this is the established convention across Prisma schema, zod validation, and all controllers. Do not introduce lowercase chain identifiers without checking this is still true.
- PIN authorization is gated through `pinLockoutService` — reuse this for any new PIN-gated flow rather than building parallel logic. Login and transfer PIN lockouts share one counter/cooldown by design, as of the last time this was verified.
- External-wallet transfers use a prepare/submit two-step flow with server-persisted, single-use, expiring intents — submit must always verify against the stored intent, never trust client-submitted transaction details directly.
- TriVerify (friend's SDK) is used for address/network validation on ETH/BTC/SOL/TRON/SUI/TON/Aptos/Polygon; ethers.js fallback is used for BSC/Base.
- Ethereum chain ID is env-driven (`ETHEREUM_CHAIN_ID`) — check the current value before assuming it's still pinned to Sepolia (11155111) for testnet. Never hardcode chain IDs regardless.
- CORS is allowlist-based via `ALLOWED_ORIGINS` env var — never revert to `origin: true`.
- Migrations must be applied with `npx prisma migrate deploy` as an explicit step — never assume a migration in the migrations folder is actually applied to the live database; verify with `npx prisma migrate status` when in doubt.

If any of the above turns out to be inaccurate or has changed, update this file to reflect the current reality rather than leaving it stale for the next session.

## Testing
CI runs `npm test` + `tsc --noEmit` on every push/PR to main. Keep this green — do not merge or consider a task complete if CI would fail.
