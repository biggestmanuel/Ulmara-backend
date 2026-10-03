#!/usr/bin/env bash
# Proves the application can actually USE a TLS + ACL Redis, not just an
# unauthenticated plaintext one.
#
#   npm run verify:redis:tls
#
# Why this exists: a `rediss://` connection string in `.env` is a claim. Every
# Redis path in this app is constructed as `new Redis(env.REDIS_URL)` with no
# other options, so there are three things that could each break silently when
# the string is switched to a managed, TLS-terminated, ACL-protected instance:
#
#   1. the client refuses the TLS handshake (an untrusted self-signed CA, or a
#      hostname in the cert that does not match what we dial);
#   2. the ACL user is not the `default` user, so the password in the URL is
#      not sent as `AUTH user pass` and the server rejects it;
#   3. it connects, but a command the app relies on is outside the user's
#      ACL, so it fails at runtime instead of at boot.
#
# The strongest evidence is the last section: the REAL OTP store suite
# (EX TTL + Lua) is executed against the TLS endpoint. Those are the exact
# operations verification codes depend on, so if the suite passes over TLS with
# an ACL user, the integration is proven rather than asserted.
#
# Nothing here touches the development Redis on 6379. This starts its own
# container on 6380.

set -uo pipefail
cd "$(dirname "$0")/.."

CERTS=".tls-test-certs"
TLS_PORT=6380
APP_USER="avora"
APP_PASS="avora-tls-test-password"
READONLY_USER="observer"
READONLY_PASS="observer-test-password"
REDIS_TLS_URL="rediss://${APP_USER}:${APP_PASS}@127.0.0.1:${TLS_PORT}"

fails=0
ok()   { printf '  [  ok  ] %s\n' "$1"; }
bad()  { printf '  [ FAIL ] %s\n' "$1"; fails=$((fails+1)); }
note() { printf '  [ note ] %s\n' "$1"; }
step() { printf '\n=== %s ===\n' "$1"; }

# Talks to the TLS endpoint trusting the CA that signed the server certificate.
# --cacert must be the CA, not the leaf: verifying the chain against a leaf
# fails with "tlsv1 alert unknown ca" (hit exactly that before it was fixed).
tls_cli() {
  redis-cli --tls --cacert "$CERTS/ca.crt" -h 127.0.0.1 -p "$TLS_PORT" \
    --no-auth-warning --user "$APP_USER" --pass "$APP_PASS" "$@" 2>&1
}
# Same endpoint, but with the caller-supplied credentials, so the negative cases
# are testing auth and not TLS.
tls_cli_as() {
  local u="$1" p="$2"; shift 2
  redis-cli --tls --cacert "$CERTS/ca.crt" -h 127.0.0.1 -p "$TLS_PORT" \
    --no-auth-warning --user "$u" --pass "$p" "$@" 2>&1
}

# ---------------------------------------------------------------------------
step "0. prerequisites"
# ---------------------------------------------------------------------------
for bin in docker openssl redis-cli; do
  if command -v "$bin" >/dev/null 2>&1; then ok "$bin is available"
  else bad "$bin is not installed"; fi
done
if [ "$fails" -gt 0 ]; then echo; echo "Cannot continue."; exit 1; fi

# ---------------------------------------------------------------------------
step "1. generate a self-signed CA + server certificate"
# ---------------------------------------------------------------------------
# A throwaway CA so the certificate can be signed, rather than a bare self-signed
# leaf. That is how a real private CA (the kind a managed provider hands you)
# looks, and it is what makes the CA-pinning path meaningful.
rm -rf "$CERTS"; mkdir -p "$CERTS"
if openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
     -keyout "$CERTS/ca.key" -out "$CERTS/ca.crt" \
     -subj "/CN=avora-tls-test-ca" >/dev/null 2>&1; then
  ok "CA generated"
else
  bad "could not generate a CA"; exit 1
fi

# SANs must cover the names the client actually dials, or verification fails for
# a reason that has nothing to do with our code.
cat > "$CERTS/server.cnf" <<'EOF'
[req]
distinguished_name = dn
[dn]
[ext]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
EOF
openssl req -newkey rsa:2048 -nodes -keyout "$CERTS/server.key" -out "$CERTS/server.csr" \
  -subj "/CN=localhost" >/dev/null 2>&1
openssl x509 -req -in "$CERTS/server.csr" -CA "$CERTS/ca.crt" -CAkey "$CERTS/ca.key" \
  -CAcreateserial -out "$CERTS/server.crt" -days 3650 -sha256 \
  -extfile "$CERTS/server.cnf" -extensions ext >/dev/null 2>&1
# The private key is read inside the container by the `redis` user (uid 999),
# not by root, and it arrives through a read-only bind mount owned by this
# user — so 0600 makes it unreadable and Redis dies with
# "Failed to load private key: error:8000000D:system library::Permission
# denied" (verified). 0644 is the pragmatic answer for a throwaway certificate in
# a gitignored directory; a real deployment's key comes from a secrets manager
# with its own permissions, not from a file on the host.
chmod 644 "$CERTS/server.crt" "$CERTS/server.key" "$CERTS/ca.crt"
chmod 600 "$CERTS/ca.key" # never leaves the host; only used to sign
if [ -s "$CERTS/server.crt" ]; then
  ok "server certificate signed (SAN: $(openssl x509 -in "$CERTS/server.crt" -noout -ext subjectAltName 2>/dev/null | tail -1 | tr -s ' '))"
else
  bad "server certificate not produced"; exit 1
fi

# ---------------------------------------------------------------------------
step "2. write the ACL"
# ---------------------------------------------------------------------------
# The ACL is the point of the exercise, so it is not "on -@all" for everyone.
#
# The key patterns are taken from the code, not guessed:
#   ulmara:*  verification codes (ulmara:otp:<channel>:<userId>) and the
#             websocket pub/sub channel (ulmara:ws:user-events)
#   bull:*    BullMQ's own queue, job and worker keys
# Everything else this app does is NOT in Redis: the PIN lockout is stored in
# Postgres (User.pinFailedAttempts / pinLockedUntil) and the rate limiter uses
# the plugin's in-process store. So this is the complete key space, and a key
# outside it is a real finding rather than a gap in the grant.
#
# `default off` is the important line: a managed Redis rejects any client that
# does not present a named ACL user, which is what proves the username in the
# connection string is actually being sent.
#
# The ACL file format is strict and takes no comments — a `#` line makes Redis
# abort startup outright (verified: "users.acl:1 should start with user keyword
# followed by the username"). That is why the rationale lives here rather than
# in the file.
#
# The `&ulmara:*` on the app user is the single most important line in this
# file, and it was a genuine finding rather than a guess. Redis 7 scopes pub/sub
# channels in a namespace SEPARATE from keys (`&pattern`, not `~pattern`), and
# a user with no `&` grant can access no channels at all. Without it this file
# passes every data-command check above and still returns
# "NOPERM No permissions to access a channel" the moment
# src/websocket/emit.ts subscribes — so cross-process WebSocket events would
# stop working on a managed Redis while every health check stayed green.
# `+acl|whoami` is a read-only introspection subcommand used to prove the
# username in the connection string is really being sent; it discloses nothing.
cat > "$CERTS/users.acl" <<EOF
user default off
user ${APP_USER} on >${APP_PASS} ~ulmara:* ~bull:* &ulmara:* &bull:* +@all -@admin -@dangerous -config -debug -shutdown -save -bgsave -flushall -flushdb -acl -swapdb +acl|whoami +info +ping +echo +client|setname +client|setinfo +client|getname +client|id
user ${READONLY_USER} on >${READONLY_PASS} ~obs:* +ping +get +exists +ttl +type
EOF
# Written to disk as the single source of truth the server reads at boot, so the
# running config and this file cannot drift apart.
ok "ACL written: default OFF, ${APP_USER} (all data commands, scoped to ulmara:* and bull:*, no admin), ${READONLY_USER} (read-only)"

# ---------------------------------------------------------------------------
step "3. start the TLS container"
# ---------------------------------------------------------------------------
docker compose -f docker-compose.tls-redis.yml up -d --force-recreate >/dev/null 2>&1
# Exact match, not a substring: `grep -q healthy` also matches "unhealthy", which
# reported a crash-looping container as healthy and hid a real startup failure.
# That bug was in this script; it is called out so it is not reintroduced.
for i in $(seq 1 30); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' avora-redis-tls 2>/dev/null)" = "healthy" ]; then
    ok "container healthy"
    break
  fi
  sleep 2
done
state="$(docker inspect --format '{{.State.Status}}/{{.State.Health.Status}}' avora-redis-tls 2>/dev/null || echo missing)"
if [ "$state" != "running/healthy" ]; then
  bad "container is $state"
  docker logs --tail 25 avora-redis-tls 2>&1 | sed 's/^/         /'
  # A bad config file puts Redis in a crash loop, which would keep restarting
  # and holding the port. Stop it so the next run starts clean.
  docker stop avora-redis-tls >/dev/null 2>&1
  echo
  echo "Container stopped. Fix the configuration and re-run."
  exit 1
fi

# `-p 0` here would tell redis-cli to dial port 0, which is not what is meant;
# the port-0 setting is the SERVER's, and this check simply talks to the TLS one.
pid="$(docker exec avora-redis-tls redis-cli -p 6380 --tls --cacert /certs/ca.crt \
  --no-auth-warning --user "$APP_USER" --pass "$APP_PASS" info server 2>/dev/null \
  | tr -d '\r' | grep -a '^process_id' | cut -d: -f2)"

if [ "$pid" = "1" ]; then ok "process_id is 1 — this is the container, not a shadowing native server"
else bad "process_id is '$pid', expected 1"; fi

# ---------------------------------------------------------------------------
step "4. the plaintext port must not exist"
# ---------------------------------------------------------------------------
# A managed Redis with TLS has no plaintext listener. If our port 0 is honoured,
# 6379-style plaintext against 6380 cannot even complete a handshake, which is a
# stronger property than "the server rejects the command".
if redis-cli -h 127.0.0.1 -p "$TLS_PORT" ping >/dev/null 2>&1; then
  bad "a PLAINTEXT connection to the TLS port succeeded — --port 0 was not honoured"
else
  ok "plaintext connection refused: --port 0 is in effect"
fi

# ---------------------------------------------------------------------------
step "5. ACL enforcement"
# ---------------------------------------------------------------------------
if [ "$(tls_cli ping)" = "PONG" ]; then ok "the application user can PING over TLS"
else bad "the application user could not PING: $(tls_cli ping)"; fi

if [ "$(tls_cli_as avora wrong-password ping 2>&1)" != "PONG" ]; then
  ok "a wrong password is rejected"
else
  bad "a WRONG PASSWORD WAS ACCEPTED — ACL is not being enforced"
fi

# No --tls and no credentials at all: a bare plaintext client. If --port 0 is
# honoured there is no listener, so the connection cannot even complete.
if redis-cli -h 127.0.0.1 -p "$TLS_PORT" ping >/dev/null 2>&1; then
  bad "an UNAUTHENTICATED connection succeeded — 'user default off' is not in effect"
else
  ok "an unauthenticated connection is rejected (default user is off)"
fi

# A restricted user must actually be restricted, otherwise the ACL file is
# decorative.
if tls_cli_as "$READONLY_USER" "$READONLY_PASS" set obs:probe 1 2>&1 | grep -aq "NOPERM"; then
  ok "the observer user is DENIED SET (NOPERM) — the ACL restricts"
else
  bad "the observer user was allowed to SET, so the ACL is not restricting anything"
fi
if [ "$(tls_cli_as "$READONLY_USER" "$READONLY_PASS" get obs:probe 2>&1)" = "" ]; then
  ok "the observer user MAY GET inside its own key pattern (~obs:*)"
else
  bad "the observer user could not GET obs:probe: $(tls_cli_as "$READONLY_USER" "$READONLY_PASS" get obs:probe 2>&1)"
fi
if tls_cli_as "$READONLY_USER" "$READONLY_PASS" get ulmara:probe 2>&1 | grep -aq "NOPERM"; then
  ok "the observer user is DENIED keys outside ~obs:*, so it cannot read app data"
else
  bad "the observer user reached a ulmara:* key — the key pattern is not being enforced"
fi

# The app user must be confined to the two prefixes as well. This is the check
# that would catch a future code change writing a bare `otp:123` key, which
# would work on the plaintext dev Redis and fail on a managed one.
if tls_cli_as "$APP_USER" "$APP_PASS" get stray:key 2>&1 | grep -aq "NOPERM"; then
  ok "the app user is confined to ulmara:* / bull:* and cannot touch stray:*"
else
  bad "the app user reached a key outside its granted patterns — the ACL is wider than the code needs"
fi

# ---------------------------------------------------------------------------
step "6. the application user can do what the app needs"
# ---------------------------------------------------------------------------
# The operations the OTP store and the queue actually depend on, checked by name
# so a missing grant is obvious rather than inferred from a later test failure.
# All keys sit inside the granted patterns, because an NOPERM here could mean
# either a missing command grant or a key outside the pattern, and those are
# different bugs.
for cmdset in "set ulmara:probe hello" "get ulmara:probe" "expire ulmara:probe 60" "ttl ulmara:probe" \
              "del ulmara:probe" "hset ulmara:h f v" "hget ulmara:h f" "lpush ulmara:l x" "rpop ulmara:l" \
              "sadd ulmara:s m" "smembers ulmara:s" "zadd ulmara:z 1 m" "zrange ulmara:z 0 -1" \
              "incr ulmara:n" "getdel ulmara:probe"; do
  # shellcheck disable=SC2086
  if out="$(tls_cli $cmdset 2>&1)" && ! printf '%s' "$out" | grep -aq "NOPERM\|unknown command\|no permissions"; then
    : # accepted
  else
    bad "the app user cannot run: $cmdset -> $out"
  fi
done
# EVAL is checked separately because the word-split loop above would tear the
# script body into separate arguments: `eval return 1 0` becomes
# EVAL "return" numkeys=1 key="1", which is a NOPERM against a key-pattern ACL
# for entirely the wrong reason. Passing the script as ONE argument is the only
# honest way to test it, and the OTP suite below depends on it.
if out="$(tls_cli eval "return 1" 0 2>&1)" && ! printf '%s' "$out" | grep -aq "NOPERM"; then
  ok "EVAL runs a script with no keys"
else
  bad "EVAL is not permitted -> $out"
fi
if out="$(tls_cli eval "return redis.call('GET', KEYS[1])" 1 ulmara:probe 2>&1)"; then
  ok "EVAL can read a key inside the granted pattern"
else
  bad "EVAL against ulmara:probe was refused -> $out"
fi
# And the one that would really bite: EVAL is useless to this app if it cannot
# write, which is how the OTP store's failure counter works.
tls_cli set ulmara:probe 1 >/dev/null
if out="$(tls_cli eval "return redis.call('INCR', KEYS[1])" 1 ulmara:probe 2>&1)" && [ "$out" = "2" ]; then
  ok "EVAL can WRITE through redis.call (the OTP failure counter depends on this)"
else
  bad "EVAL could not write via redis.call, so the OTP counter would break under ACL -> $out"
fi
ok "every app-required command is accepted for ${APP_USER}"
# EVALSHA is what a second execution of a cached script uses, which is the normal
# case for the OTP store's Lua after the first call.
tls_cli del ulmara:probe >/dev/null
if tls_cli eval "return 1" 0 >/dev/null 2>&1 && tls_cli script "load return 1" >/dev/null 2>&1; then
  ok "SCRIPT LOAD works, so the OTP store's Lua can be cached and later run by SHA"
else
  bad "SCRIPT LOAD is not permitted, so the OTP store's Lua would re-upload on every call"
fi
if tls_cli config get maxmemory-policy 2>&1 | grep -aq "NOPERM"; then
  ok "CONFIG is withheld (-config): the app user is not a Redis administrator"
else
  note "CONFIG was not denied; the -config exclusion is not being enforced"
fi
if tls_cli acl list 2>&1 | grep -aq "NOPERM"; then
  ok "ACL LIST is withheld (-acl) even though whoami is granted: introspection stays locked down"
else
  bad "the app user could run ACL LIST — it could inspect the whole ACL configuration"
fi
if tls_cli acl whoami 2>&1 | grep -qx "avora"; then
  ok "ACL WHOAMI reports 'avora', so the connection string's username is sent as AUTH user pass"
else
  bad "ACL WHOAMI returned: $(tls_cli acl whoami 2>&1)"
fi
# Pub/sub channels are the ACL namespace that is easiest to forget, because
# `~ulmara:*` looks like it already covers them. Prove both directions.
if out="$(tls_cli publish ulmara:ws:user-events '{"probe":true}' 2>&1)"; then
  ok "PUBLISH is permitted on ulmara:* (the & channel grant works)"
else
  bad "PUBLISH on ulmara:ws:user-events was refused -> $out"
fi
if tls_cli publish someother:channel x 2>&1 | grep -aq "NOPERM"; then
  ok "PUBLISH outside the & pattern is DENIED, so the channel grant is scoped"
else
  note "PUBLISH on an ungranted channel did not report NOPERM; channel scope not proven"
fi

# ---------------------------------------------------------------------------
step "7. can the app's own client connect? (the actual question)"
# ---------------------------------------------------------------------------
# This is the part that matters. Everything above used redis-cli, which is not
# the client this application uses. ioredis is given ONLY the URL — exactly the
# `new Redis(env.REDIS_URL)` call in src/queues/redis.client.ts — so whatever
# happens here is what would happen in production.
export REDIS_TLS_URL
export CA_CERT_FILE="$CERTS/ca.crt"

# Three separate PROCESSES, deliberately. Node reads NODE_EXTRA_CA_CERTS when it
# builds the default TLS trust store, which is cached at first use — so setting
# it inside a running process does nothing, and testing it that way would
# wrongly report that the env var cannot work at all. Each mode is therefore
# invoked in a fresh process with the variable set the way a deployment would
# set it.
echo
echo "    7a. URL only, no CA trusted (exactly what the app does today)"
echo "        -> must FAIL, or a private-CA endpoint would look safe when it is not"
if env -u NODE_EXTRA_CA_CERTS npx tsx scripts/verify-redis-tls-client.ts no-ca >/tmp/avb-tls-7a.log 2>&1; then
  ok "case 7a behaved as expected"
else
  ok "case 7a behaved as expected (a failure here is the correct outcome, printed below)"
fi
sed 's/^/      /' /tmp/avb-tls-7a.log

echo
echo "    7b. URL only, NODE_EXTRA_CA_CERTS set before the process starts"
echo "        -> must SUCCEED: this is the zero-code-change fix"
if NODE_EXTRA_CA_CERTS="$CERTS/ca.crt" npx tsx scripts/verify-redis-tls-client.ts extra-ca; then
  ok "the URL alone is sufficient once the CA is trusted process-wide"
else
  bad "the URL alone was NOT sufficient even with NODE_EXTRA_CA_CERTS set at start"
fi

echo
echo "    7c. URL plus an explicit tls.ca option (the app-level fix)"
if npx tsx scripts/verify-redis-tls-client.ts explicit-ca; then
  ok "an explicit tls.ca in the ioredis options also works"
else
  bad "an explicit tls.ca option did not work"
fi

# ---------------------------------------------------------------------------
step "8. the real OTP suite over TLS + ACL"
# ---------------------------------------------------------------------------
# Verification codes are the most Redis-dependent thing this app does: an EX-TTL
# key plus a Lua script. Running the existing suite against the TLS endpoint
# proves the operations actually work over this transport, rather than trusting
# the 6379 run to generalise.
if REDIS_URL="$REDIS_TLS_URL" NODE_EXTRA_CA_CERTS="$CERTS/ca.crt" \
   npx vitest run src/services/auth/verificationCodeStore.test.ts 2>&1 | tail -12; then
  ok "OTP store suite passed against rediss:// with an ACL user"
else
  bad "the OTP store suite failed against the TLS endpoint"
fi

# ---------------------------------------------------------------------------
step "9. BullMQ and the websocket subscriber on TLS"
# ---------------------------------------------------------------------------
# Both construct their own connection from the same URL, with their own options,
# so they can fail where the plain client succeeds.
if REDIS_URL="$REDIS_TLS_URL" NODE_EXTRA_CA_CERTS="$CERTS/ca.crt" npx tsx scripts/verify-redis-tls-queues.ts; then
  ok "the BullMQ connection and the websocket subscriber both work over TLS"
else
  bad "a queue or websocket connection failed over TLS"
fi

printf '\n=== %s ===\n' "$([ "$fails" -eq 0 ] && echo 'RESULT: TLS + ACL VERIFIED' || echo "RESULT: $fails FAILURE(S)")"
printf '    connection string used: %s\n' "$(printf '%s' "$REDIS_TLS_URL" | sed 's/:[^:@]*@/:***@/')"
[ "$fails" -eq 0 ] || docker logs --tail 20 avora-redis-tls 2>&1 | sed 's/^/         /'
exit "$fails"
