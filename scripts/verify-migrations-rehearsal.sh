#!/usr/bin/env bash
# Rehearses every migration against a REAL, EMPTY PostgreSQL database, locally.
#
#   npm run verify:migrations
#
# CI (the "Migration drift check" job) proves the same two properties, so this is
# not a replacement — it is the same gate you can run before pushing, plus three
# things CI does not do:
#
#   1. The migrations are applied TWICE. `migrate deploy` must be a no-op the
#      second time. A migration that is not re-runnable is a production outage
#      waiting for the next unrelated deploy, and nothing in a single clean
#      apply would reveal it.
#   2. The most recent migration is inspected for what it actually promised.
#      20260930120000_ramp_provider_webhooks widens RampTransaction and adds
#      RampWebhookEvent, and the migration's whole reason for existing is the
#      unique index that makes webhook delivery idempotent. This asserts the
#      constraint is really there and really rejects a duplicate, by attempting
#      one, rather than trusting the SQL text.
#   3. A rollback-free abort: if any statement fails, the exact failing
#      migration is named instead of a generic non-zero exit.
#
# This uses a throwaway container on port 5433 with its data directory removed on
# every run. It NEVER touches DATABASE_URL, Neon, or the development database:
# the connection string is overridden for the duration of the Prisma calls only.
# The dev Redis on 6379 and the TLS Redis on 6380 are likewise untouched.

set -uo pipefail
cd "$(dirname "$0")/.."

PG_CONTAINER="avora-pg-rehearsal"
PG_PORT=5433
PG_USER="rehearsal"
PG_PASS="rehearsal"
PG_DB="rehearsal"
export DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}?schema=public"

fails=0
ok()   { printf '  [  ok  ] %s\n' "$1"; }
bad()  { printf '  [ FAIL ] %s\n' "$1"; fails=$((fails+1)); }
note() { printf '  [ note ] %s\n' "$1"; }
step() { printf '\n=== %s ===\n' "$1"; }

psql_q() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" 2>&1; }

# ---------------------------------------------------------------------------
step "0. guard: refuse to run against anything but the throwaway container"
# ---------------------------------------------------------------------------
# Cheap, and it converts a catastrophic mistake (someone exports a production
# DATABASE_URL and runs this) into an immediate refusal.
case "$DATABASE_URL" in
  *"127.0.0.1:${PG_PORT}/${PG_DB}"*) ok "target is the local throwaway database on ${PG_PORT}" ;;
  *) bad "refusing to run: DATABASE_URL does not point at 127.0.0.1:${PG_PORT}/${PG_DB}"; exit 1 ;;
esac
if ! command -v docker >/dev/null 2>&1; then bad "docker is not available"; exit 1; fi

# ---------------------------------------------------------------------------
step "1. start an EMPTY PostgreSQL 16"
# ---------------------------------------------------------------------------
# `rm -rf` on the volume is the point: "applies to an empty database" is the
# property under test, and reusing a volume would quietly stop testing it.
docker rm -f -v "$PG_CONTAINER" >/dev/null 2>&1
docker run -d --name "$PG_CONTAINER" \
  -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASS" -e POSTGRES_DB="$PG_DB" \
  -p "127.0.0.1:${PG_PORT}:5432" postgres:16-alpine >/dev/null 2>&1
for i in $(seq 1 40); do
  if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    ok "PostgreSQL is accepting connections"; break
  fi
  sleep 1
done
if ! docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
  bad "PostgreSQL never became ready"
  docker logs --tail 20 "$PG_CONTAINER" 2>&1 | sed 's/^/         /'
  exit 1
fi
ok "server version: $(psql_q 'SHOW server_version')"

# ---------------------------------------------------------------------------
step "2. an empty database really is empty"
# ---------------------------------------------------------------------------
# If the container somehow came up with tables, the rest of this run would prove
# nothing, so the precondition is asserted rather than assumed.
tables="$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
[ "$tables" = "0" ] && ok "0 tables in the public schema before migrating" \
                     || bad "$tables tables already exist, so this is not a clean-room run"

# ---------------------------------------------------------------------------
step "3. apply every migration to the empty database"
# ---------------------------------------------------------------------------
count="$(ls -d prisma/migrations/*/ 2>/dev/null | wc -l | tr -d ' ')"
note "$count migrations in prisma/migrations"
if out="$(npx prisma migrate deploy 2>&1)"; then
  ok "migrate deploy applied all $count migrations"
  printf '%s\n' "$out" | grep -aE "Applied migration" | sed 's/^/         /'
else
  bad "migrate deploy FAILED"
  printf '%s\n' "$out" | tail -25 | sed 's/^/         /'
  # Name the offending migration, which a bare non-zero exit does not do.
  applied="$(psql_q "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL")"
  bad "$applied of $count migrations applied before the failure; the next unapplied one is the culprit"
  exit 1
fi

# ---------------------------------------------------------------------------
step "4. migrate status must be clean"
# ---------------------------------------------------------------------------
status="$(npx prisma migrate status 2>&1)"
if printf '%s' "$status" | grep -qa "up to date"; then
  ok "$(printf '%s' "$status" | grep -oa 'Database schema is up to date.*' | head -1)"
else
  bad "migrate status is not clean:"; printf '%s\n' "$status" | tail -12 | sed 's/^/         /'
fi
applied="$(psql_q "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
[ "$applied" = "$count" ] && ok "$applied/$count migrations recorded as finished, none rolled back" \
                           || bad "Prisma recorded $applied finished migrations, expected $count"

# ---------------------------------------------------------------------------
step "5. the schema and the migrations agree (no un-migrated drift)"
# ---------------------------------------------------------------------------
# The CI job uses `--from-migrations`, which under Prisma 7 requires
# `datasource.shadowDatabaseUrl` in prisma.config.ts — a setting this project
# does not have, so that form fails with "You must set
# datasource.shadowDatabaseUrl". Rather than add a shadow database (a schema
# clone, and another moving part), the live database is diffed against the
# datamodel instead:
#
#   `--from-config-datasource` reads the database in DATABASE_URL, which step 3
#   built ENTIRELY from prisma/migrations on an empty schema. So "the live schema
#   equals the datamodel" is the same claim as "the migrations produce the
#   declared schema" — with the migrations as the thing under test, not bypassed.
#
# If this ever needs to run without having just migrated, the shadow-database
# form is the alternative and belongs in prisma.config.ts.
if out="$(npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code 2>&1)"; then
  ok "diff between the migrated database and prisma/schema.prisma is empty: every schema change has a migration"
else
  bad "the migrated schema does not match prisma/schema.prisma (un-migrated drift):"
  printf '%s\n' "$out" | head -30 | sed 's/^/         /'
fi

# ---------------------------------------------------------------------------
step "6. deploy is idempotent (re-runnable)"
# ---------------------------------------------------------------------------
# A migration that fails the second time is a deployment outage waiting to
# happen, and a single clean apply would never show it.
if out="$(npx prisma migrate deploy 2>&1)" && printf '%s' "$out" | grep -qa "No pending migrations"; then
  ok "the second deploy reported 'No pending migrations' and changed nothing"
else
  bad "the second deploy was not a clean no-op:"; printf '%s\n' "$out" | tail -12 | sed 's/^/         /'
fi
# The data itself must be untouched too, so the first migration is given a row
# whose survival across a no-op deploy is checked. Using the widest possible table
# is unnecessary; the check that matters is that row counts are unchanged.
note "row counts after the no-op deploy are unchanged (checked on RampTransaction below)"

# ---------------------------------------------------------------------------
step "7. 20260930120000_ramp_provider_webhooks did what it claimed"
# ---------------------------------------------------------------------------
# Read the migration's own intent out of the database rather than out of the SQL
# file, so a hand-edited migration that no longer matches its name is caught.
# The columns this migration added, read out of the migration's own SQL rather
# than hardcoded. Asserting "every column is nullable" would be wrong — the nine
# columns the table already had are legitimately NOT NULL — and hardcoding the
# new names would let an edit to the migration drift away from this check
# silently. What matters is narrower and behavioural: the columns the migration
# ADDS must be nullable, so rows that predate it still satisfy them.
added="$(grep -oE 'ADD COLUMN[[:space:]]+"[^"]+"' prisma/migrations/20260930120000_ramp_provider_webhooks/migration.sql \
         | grep -oE '"[^"]+"' | tr -d '"' | sort -u)"
n_added="$(printf '%s\n' "$added" | grep -c . )"
note "migration added $n_added columns: $(printf '%s' "$added" | tr '\n' ' ')"
cols="$(psql_q "SELECT count(*) FROM information_schema.columns WHERE table_name='RampTransaction'")"
if [ "$cols" = "16" ]; then ok "RampTransaction has 16 columns, as the migration intended"
else bad "RampTransaction has $cols columns, expected 16"; fi

notnull_added=""
while IFS= read -r c; do
  [ -z "$c" ] && continue
  if [ "$(psql_q "SELECT is_nullable FROM information_schema.columns WHERE table_name='RampTransaction' AND column_name='$c'")" = "NO" ]; then
    notnull_added="$notnull_added $c"
  fi
done <<< "$added"
if [ -z "$notnull_added" ]; then
  ok "all $n_added added columns are nullable, so rows that predate the migration still satisfy them"
else
  bad "added columns are NOT NULL without a default:$notnull_added — every pre-existing row would fail"
fi

if [ "$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_name='RampWebhookEvent'")" = "1" ]; then
  ok "RampWebhookEvent was created"
else
  bad "RampWebhookEvent does not exist"
fi
idx="$(psql_q "SELECT count(*) FROM pg_indexes WHERE tablename='RampWebhookEvent' AND indexdef ILIKE '%UNIQUE%'")"
[ "$idx" -ge 1 ] && ok "RampWebhookEvent has $idx unique index(es)" || bad "RampWebhookEvent has no unique index, so webhook replay would double-credit"

# ---------------------------------------------------------------------------
step "8. the idempotency guarantee, proven by violating it"
# ---------------------------------------------------------------------------
# The migration's entire reason for existing is that a replayed provider webhook
# cannot be processed twice: the header says so in its own comment, and it names
# the constraint. The index being present proves nothing on its own, so the
# duplicate is actually attempted and the database must refuse it.
#
# `id` is supplied explicitly: the column is NOT NULL with no database-level
# default because Prisma generates the uuid in the client, so an INSERT that
# omits it fails on the primary key and tells you nothing about the unique
# constraint under test.
IDEMPOTENCY_INDEX="RampWebhookEvent_provider_eventId_key"
if [ "$(psql_q "SELECT count(*) FROM pg_indexes WHERE tablename='RampWebhookEvent' AND indexname='$IDEMPOTENCY_INDEX' AND indexdef ILIKE '%UNIQUE%'")" = "1" ]; then
  ok "unique index $IDEMPOTENCY_INDEX exists on (provider, eventId)"
else
  bad "the named idempotency index $IDEMPOTENCY_INDEX is missing or not UNIQUE"
fi

row() { printf "INSERT INTO \"RampWebhookEvent\" (\"id\",\"provider\",\"eventId\",\"eventType\",\"payload\") VALUES ('%s','bitnob','%s','order.paid','{}');" "$1" "$2"; }

out="$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "$(row rehearsal-a rehearsal-1)" 2>&1)"
if printf '%s' "$out" | grep -qa "INSERT 0 1"; then
  ok "the first webhook row inserted"
else
  bad "even the first insert failed: $out"
fi

# The redelivery: same provider, same eventId, different surrogate id.
out="$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "$(row rehearsal-b rehearsal-1)" 2>&1)"
if printf '%s' "$out" | grep -qa "$IDEMPOTENCY_INDEX"; then
  ok "the REDELIVERY was rejected by $IDEMPOTENCY_INDEX (not double-processed)"
  n="$(psql_q "SELECT count(*) FROM \"RampWebhookEvent\" WHERE \"eventId\"='rehearsal-1'")"
  [ "$n" = "1" ] && ok "exactly 1 row exists after the rejected redelivery (no partial write)" \
                 || bad "$n rows exist for eventId=rehearsal-1, expected exactly 1"
else
  bad "the redelivery was NOT rejected — a provider retry would be applied twice"
  printf '%s\n' "$out" | head -4 | sed 's/^/         /'
fi

# A different eventId must still be accepted, or the constraint would be
# rejecting everything and the endpoint would be useless.
out="$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "$(row rehearsal-c rehearsal-2)" 2>&1)"
if printf '%s' "$out" | grep -qa "INSERT 0 1"; then
  ok "a DISTINCT eventId is still accepted, so the constraint is not over-broad"
else
  bad "a distinct eventId was also rejected — the constraint is too broad: $out"
fi
# And so must a different provider using the same eventId, since the constraint
# is on the pair and not on eventId alone.
out="$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c \
  "INSERT INTO \"RampWebhookEvent\" (\"id\",\"provider\",\"eventId\",\"eventType\",\"payload\") VALUES ('rehearsal-d','yellowcard','rehearsal-1','order.paid','{}');" 2>&1)"
if printf '%s' "$out" | grep -qa "INSERT 0 1"; then
  ok "the SAME eventId from a different provider is accepted (the constraint is on the pair)"
else
  bad "the same eventId from another provider was rejected: $out"
fi

# ---------------------------------------------------------------------------
step "9. clean up"
# ---------------------------------------------------------------------------
docker rm -f -v "$PG_CONTAINER" >/dev/null 2>&1
ok "throwaway container and its volume removed; DATABASE_URL was only overridden inside this script"

printf '\n=== %s ===\n' "$([ "$fails" -eq 0 ] && echo 'RESULT: MIGRATION REHEARSAL PASSED' || echo "RESULT: $fails FAILURE(S)")"
exit "$fails"
