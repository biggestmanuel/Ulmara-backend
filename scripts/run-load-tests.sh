#!/usr/bin/env bash
#
# Concurrent load test for the rate limiter and the PIN lockout.
#
#   npm run test:load
#
# Runs the suite in src/load/ against a real local Redis. It sets
# TRUSTED_PROXIES to the loopback addresses FIRST, because the per-client-budget
# test needs `request.ip` to be the X-Forwarded-For value: that is the only way
# to simulate two different clients hitting one shared server, and it is the
# configuration a real deployment behind a proxy must use (see
# `resolveTrustProxy` in src/server/app.ts and TRUSTED_PROXIES in .env.example).
#
# `test-verify.ts` and the main suite are unaffected: this only sets variables for
# this process.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export TRUSTED_PROXIES="${TRUSTED_PROXIES:-127.0.0.1,::1}"

# Fail fast with a useful message rather than a confusing connection error.
if ! redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then
  echo "Redis is not reachable at $REDIS_URL." >&2
  echo "Start it with: docker compose up -d" >&2
  exit 1
fi

echo "=== concurrent load: rate limiter + PIN lockout ==="
echo "    REDIS_URL=$REDIS_URL  TRUSTED_PROXIES=$TRUSTED_PROXIES"
echo
npx vitest run src/load/ --reporter=verbose "$@"
