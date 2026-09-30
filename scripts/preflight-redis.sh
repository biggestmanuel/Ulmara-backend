#!/usr/bin/env bash
#
# Asserts the Redis at REDIS_URL is the one we think it is, BEFORE anything
# measures or depends on it.
#
#   npm run preflight:redis
#
# ## Why this exists
#
# During the hardening pass, a *native* `redis-server` running inside WSL was
# bound to 127.0.0.1:6379 and silently shadowed the `avora-redis` container for
# every process launched in WSL — including the whole test suite. A chunk of
# earlier "measured" Redis behaviour was therefore measuring the wrong server
# (different version, no AOF, `dir` pointing at a code folder), and none of it
# looked wrong: PING answered, keys were there, tests passed.
#
# Nothing about the failure looked like a failure. That is exactly why this
# check is a separate, loud, early gate rather than a comment.
#
# ## The discriminator
#
# A containerised Redis always reports `process_id: 1`, because the server is
# PID 1 in its PID namespace. A natively-started redis-server reports its own
# PID. `executable` is a second tell: inside the container it is the image's
# path, outside it is a host path.
#
# Set REQUIRE_REDIS_CONTAINER=false to skip the container assertion (e.g. when
# deliberately testing against a locally installed Redis). The connection
# check still runs.
set -uo pipefail

URL="${REDIS_URL:-redis://127.0.0.1:6379}"
REQUIRE_CONTAINER="${REQUIRE_REDIS_CONTAINER:-true}"

fatal() { printf '\n  FAIL  %s\n\n' "$1" >&2; exit 1; }

printf '=== Redis preflight ===\n'
printf '  REDIS_URL               : %s\n' "$URL"
printf '  REQUIRE_REDIS_CONTAINER : %s\n' "$REQUIRE_CONTAINER"

# --- reachable? -------------------------------------------------------------
if ! redis-cli -u "$URL" ping >/dev/null 2>&1; then
  fatal "cannot reach Redis at $URL (is it running? try: docker compose up -d)"
fi
printf '  PING                    : PONG\n'

# --- identity ---------------------------------------------------------------
info="$(redis-cli -u "$URL" info server 2>/dev/null | tr -d '\r')"
version="$(printf '%s' "$info" | awk -F: '/^redis_version:/ {print $2}')"
pid="$(printf '%s' "$info" | awk -F: '/^process_id:/ {print $2}')"
exec_path="$(printf '%s' "$info" | awk -F: '/^executable:/ {print $2}')"
run_id="$(printf '%s' "$info" | awk -F: '/^run_id:/ {print $2}')"

printf '  redis_version           : %s\n' "$version"
printf '  process_id              : %s\n' "$pid"
printf '  run_id                  : %s\n' "${run_id:0:16}…"
printf '  executable              : %s\n' "${exec_path:-<not reported>}"

# Anything listening locally that is NOT the container, shadowing it.
shadowing="$( (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) \
  | grep -F "$URL" | grep -F "$(printf '%s' "$URL" | sed -E 's#.*//([^:/]+).*#\1#')" \
  | grep -F 'redis-server' | grep -v "pid=1" || true)"
if [ -n "${shadowing:-}" ] && [ "$REQUIRE_CONTAINER" = "true" ]; then
  printf '\n  FAIL  a native redis-server is listening on this address and is NOT PID 1:\n%s\n' "$shadowing" >&2
  printf '        It is shadowing the container. Stop it, or set REQUIRE_REDIS_CONTAINER=false\n' >&2
  printf '        if this is intentional. See AGENTS.md -> Environment gotchas.\n\n' >&2
  exit 1
fi

if [ "$REQUIRE_CONTAINER" = "true" ] && [ "$pid" != "1" ]; then
  fatal "expected the container (process_id 1) but got process_id $pid — something else is on $URL"
fi

# --- durability, because losing a queued transfer is not a small problem ----
cfg() { redis-cli -u "$URL" config get "$1" 2>/dev/null | tail -1 | tr -d '\r'; }
appendonly="$(cfg appendonly)"
appendfsync="$(cfg appendfsync)"
maxmemory_policy="$(cfg maxmemory-policy)"
maxmemory="$(cfg maxmemory)"

printf '  appendonly              : %s\n' "$appendonly"
printf '  appendfsync             : %s\n' "$appendfsync"
printf '  maxmemory-policy        : %s\n' "$maxmemory_policy"
printf '  maxmemory               : %s\n' "$maxmemory"

if [ "$maxmemory_policy" != "noeviction" ]; then
  fatal "maxmemory-policy is '$maxmemory_policy'; BullMQ requires 'noeviction' (any eviction-capable policy can silently discard a queued transfer)"
fi

if [ "$REQUIRE_CONTAINER" = "true" ]; then
  if [ "$appendonly" != "yes" ]; then
    fatal "appendonly is '$appendonly'; this project requires AOF (see docker-compose.yml and OPERATIONS.md §4)"
  fi
  # A named volume is what makes the data survive a container recreate.
  if command -v docker >/dev/null 2>&1; then
    mounts="$(docker inspect avora-redis --format '{{range .Mounts}}{{.Type}}:{{.Name}}->{{.Destination}} {{end}}' 2>/dev/null || true)"
    printf '  volume mounts           : %s\n' "${mounts:-<docker unavailable>}"
    case "$mounts" in
      *volume:*) : ;;
      *) fatal "avora-redis has no named volume for /data; a container recreate would lose the queue" ;;
    esac
  fi
fi

printf '\n  PASS  Redis identity, eviction policy and durability are all as expected.\n\n'
exit 0
