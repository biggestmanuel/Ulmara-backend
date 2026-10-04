#!/usr/bin/env bash
# Pre-boot guard for the DATABASE_URL this process was given.
#
# Why this exists: on 2026-10-03 the disposable test database was pointed at
# `avora-fe-pg`, a Postgres container that was ALSO serving another project. That
# project's test harness ran
#   DROP DATABASE IF EXISTS carbon_trace; CREATE DATABASE carbon_trace;
# against the shared server, and `ulmara_fe_test` went with it. Every
# Prisma-backed endpoint returned 500 for seven hours while /health/ready
# reported `database: ok`, because `SELECT 1` succeeds against an empty database.
#
# The mistake was not a code bug — it was pointing at infrastructure that another
# process could destroy. This refuses to boot rather than repeat it.
#
# Run it before starting the API, the worker, or anything else that opens the
# database:   npm run verify:env
set -uo pipefail

fail=0
ok()   { printf '  [  ok  ] %s\n' "$1"; }
bad()  { printf '  [ FAIL ] %s\n' "$1"; fail=$((fail + 1)); }
note() { printf '  [ note ] %s\n' "$1"; }

echo "=== 1. DATABASE_URL is set ==="
if [ -z "${DATABASE_URL:-}" ]; then
  bad "DATABASE_URL is unset — nothing can be verified"
  echo
  echo "  RESULT: FAILED"
  exit 1
fi
# Print host/port/db only. Never the password.
# The authority is "host:port", so host and port must be split BEFORE either is
# compared — matching a bare "127.0.0.1" against "127.0.0.1:5435" silently fails
# and reports a loopback database as remote.
DB_AUTH=$(printf '%s' "$DATABASE_URL" | sed -E 's#.*@([^/]+)/.*#\1#')
DB_HOST=$(printf '%s' "$DB_AUTH" | sed -E 's#^(\[[^]]+\]|[^:]+)(:[0-9]+)?$#\1#')
DB_PORT=$(printf '%s' "$DB_AUTH" | sed -nE 's#^.*:([0-9]+)$#\1#p')
[ -z "$DB_PORT" ] && DB_PORT=5432
DB_NAME=$(printf '%s' "$DATABASE_URL" | sed -E 's#.*/([^?]+).*#\1#')
ok "DATABASE_URL is set -> ${DB_HOST}:${DB_PORT}/${DB_NAME}  (password not shown)"

echo
echo "=== 2. it is a local database, not a hosted one ==="
# A typo in the host is the classic way a disposable script ends up pointed at
# production. Neon and every other managed provider are remote by definition.
case "$DB_HOST" in
  127.0.0.1|localhost|::1|host.docker.internal)
    ok "host is loopback (${DB_HOST})" ;;
  *)
    if [ "${ALLOW_REMOTE_DATABASE:-}" = "1" ]; then
      note "host is REMOTE (${DB_HOST}) but ALLOW_REMOTE_DATABASE=1, so continuing"
      note "if that was not deliberate, unset it and re-run"
    else
      bad "host is REMOTE (${DB_HOST}) — refusing"
      echo "         This project keeps disposable work on loopback."
      echo "         Set ALLOW_REMOTE_DATABASE=1 only if you truly mean to use a"
      echo "         remote database, and check which one it is first."
    fi ;;
esac

echo
echo "=== 3. it is this project's own container, not the shared one ==="
# avora-fe-pg was stopped deliberately. Starting it again re-creates the exact
# condition that caused the outage, so treat pointing at it as an error.
case "${DB_HOST}:${DB_PORT}" in
  *:5434)
    bad "port 5434 is the STOPPED shared container avora-fe-pg — refusing"
    echo "         Ulmara's own database is ulmara-pg on 5435."
    echo "         Start it with: docker start ulmara-pg" ;;
  *:5433)
    bad "port 5433 is held by another project's container (unimap-db) — refusing"
    echo "         That is how the migration rehearsal used to fail here."
    echo "         If you meant Ulmara: ulmara-pg is on 5435." ;;
  *)
    ok "not one of the known-wrong ports (5433 shared, 5434 stopped)" ;;
esac

echo
echo "=== 4. the schema is actually deployed ==="
# The check that would have caught the outage in seconds. `SELECT 1` is not
# enough: it succeeds against an empty database.
#
# Only meaningful for a LOOPBACK database, which is the only one this script can
# reach with `docker exec`. Probing the local ulmara-pg with a remote URL's
# credentials would report a failure that has nothing to do with the URL under
# test, so a remote host is skipped and left to step 2's verdict.
case "$DB_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    note "host is not loopback, so the schema cannot be checked from here"
    note "run 'npx prisma migrate status' against it directly if unsure"
    ;;
esac

if [ "$DB_HOST" = "127.0.0.1" ] || [ "$DB_HOST" = "localhost" ] || [ "$DB_HOST" = "::1" ]; then
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx 'ulmara-pg'; then
    PGU=$(printf '%s' "$DATABASE_URL" | sed -E 's#.*://([^:]+):.*#\1#')
    PGP=$(printf '%s' "$DATABASE_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')
    COUNT=$(PGPASSWORD="$PGP" docker exec -e PGPASSWORD="$PGP" ulmara-pg \
              psql -U "$PGU" -d "$DB_NAME" -tAc \
              'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL' 2>/dev/null)
    if [ -z "$COUNT" ]; then
      bad "could not read _prisma_migrations from ulmara-pg"
      echo "         The database is empty, unreachable, or the schema was never"
      echo "         deployed. Apply it with: npx prisma migrate deploy"
    elif [ "$COUNT" -eq 0 ] 2>/dev/null; then
      bad "0 migrations applied — the schema does not exist"
      echo "         This is the 2026-10-03 failure mode: reachable, but every"
      echo "         query fails. Apply it with: npx prisma migrate deploy"
    else
      ok "$COUNT migrations applied in ${DB_NAME}"
    fi
  else
    note "ulmara-pg is not running, so the schema was not checked"
    note "start it with: docker start ulmara-pg"
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "=== RESULT: SAFE TO BOOT ==="
  exit 0
fi
echo "=== RESULT: FAILED ($fail problem(s)) — not booting into this ==="
exit 1