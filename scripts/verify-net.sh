#!/bin/bash
# Bring every "which address" fact into one place, and make the disagreement loud.
set -uo pipefail

FE_ENV=/home/biggestmanuel/dev/avora-frontend/.env
BACKEND_ENV=/home/biggestmanuel/dev/ulmara-fe-backend.env
PORT=4100
pass=0; fail=0
ok()  { printf '  [  ok  ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [ FAIL ] %s\n' "$1"; fail=$((fail+1)); }

echo "=== 1. the address this machine has RIGHT NOW ==="
# The primary LAN IPv4: the global-scope address that is not loopback and not the
# WSL-internal 10.255.255.254 that mirrored mode puts on `lo`.
LAN=$(ip -4 -o addr show scope global \
      | awk '{print $4}' | cut -d/ -f1 \
      | grep -vE '^(127\.|10\.255\.)' | head -1)
ALL=$(ip -4 -o addr show scope global | awk '{print $2"="$4}' | tr '\n' ' ')
echo "     LAN address : ${LAN:-<none found>}"
echo "     all global  : $ALL"
[ -n "$LAN" ] && ok "a LAN IPv4 was found" || bad "no global IPv4 outside loopback — the host may be offline"

echo
echo "=== 2. is the API listening where it should be? ==="
BIND=$(ss -ltn 2>/dev/null | grep ":$PORT " | awk '{print $4}' | head -1)
echo "     bound to    : ${BIND:-<not listening>}"
if [ "$BIND" = "0.0.0.0:$PORT" ] || [ "$BIND" = "*:$PORT" ]; then
  ok "bound to every interface, so the LAN is covered from inside WSL"
elif [ -n "$BIND" ]; then
  bad "bound to $BIND only — a phone on the LAN cannot reach it. It must be 0.0.0.0:$PORT"
else
  bad "nothing is listening on $PORT. Start the API first."
fi

echo
echo "=== 3. can the LAN address actually serve the API? ==="
if [ -n "$LAN" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://$LAN:$PORT/health" 2>/dev/null)
  echo "     http://$LAN:$PORT/health -> ${CODE:-no response}"
  [ "$CODE" = "200" ] && ok "reachable on the LAN address from this host" \
                      || bad "not reachable on $LAN. In mirrored mode this usually means the socket is not exposed to the host's interfaces."
fi

echo
echo "=== 4. does the Windows host firewall allow inbound $PORT? ==="
# Read-only. A phone cannot reach this machine unless Windows lets it, and the
# WSL2 NAT/Hyper-V firewall is a separate layer that also has to agree.
RULE=$(powershell.exe -NoProfile -Command \
  "(Get-NetFirewallPortFilter | Where-Object {\$_.LocalPort -eq $PORT} | Measure-Object).Count" 2>/dev/null | tr -d '\r[:space:]')
echo "     inbound rules for port $PORT: ${RULE:-0}"
if [ "${RULE:-0}" -ge 1 ] 2>/dev/null; then
  ok "a Windows inbound rule exists for $PORT"
else
  bad "NO Windows inbound rule for port $PORT. A phone on the LAN will time out."
  echo "           Ask the user to run, in an ADMIN PowerShell:"
  echo "             New-NetFirewallRule -DisplayName 'WSL $PORT' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $PORT -Profile Private"
fi
PROXY=$(powershell.exe -NoProfile -Command \
  "netsh interface portproxy show v4tov4 | Select-String '^\s*0\.0\.0\.0\s+$PORT'" 2>/dev/null | tr -d '\r')
[ -n "$PROXY" ] && ok "a portproxy forwards $PORT" \
  || echo "     note: no portproxy for $PORT — that is FINE under mirrored networking, only needed for NAT mode"

echo
echo "=== 5. do the configs agree with the address above? ==="
FE_URL=$(grep -E '^EXPO_PUBLIC_API_BASE_URL=' "$FE_ENV" 2>/dev/null | head -1 | cut -d= -f2-)
FE_IP=$(printf '%s' "${FE_URL#*://}" | cut -d: -f1)
echo "     frontend .env   : ${FE_URL:-<unset>}"
if [ -z "$FE_URL" ]; then
  bad "EXPO_PUBLIC_API_BASE_URL is unset. lib/api/client.ts has NO fallback, so every request would resolve against the app's own origin and fail with no useful message."
elif [ "$FE_IP" = "$LAN" ]; then
  ok "the frontend points at this machine's current LAN address"
else
  bad "the frontend points at $FE_IP but this machine is $LAN. The phone will get 'Network request failed'."
  echo "           Fix: sed -i 's|^EXPO_PUBLIC_API_BASE_URL=.*|EXPO_PUBLIC_API_BASE_URL=http://$LAN:$PORT|' $FE_ENV"
  echo "           then restart Expo — EXPO_PUBLIC_* values are inlined at bundle time."
fi

CORS=$(grep -E '^[[:space:]]*(export[[:space:]]+)?ALLOWED_ORIGINS=' "$BACKEND_ENV" 2>/dev/null | head -1 | cut -d= -f2-)
if printf '%s' "$CORS" | tr ',' '\n' | grep -q "http://$LAN:8081"; then
  ok "the CORS allowlist already contains this machine's $LAN:8081 (Expo web)"
else
  bad "the CORS allowlist has no http://$LAN:8081, so Expo web in a LAN browser will be blocked."
  echo "           ALLOWED_ORIGINS currently mentions: $(printf '%s' "$CORS" | tr ',' '\n' | grep -oE 'http://192\.168\.[0-9.]+:[0-9]+' | tr '\n' ' ')"
fi

echo
echo "  $pass passed / $fail failed"
if [ "$fail" -gt 0 ]; then
  echo
  echo "  RESULT: NOT READY FOR A PHONE ON THE LAN"
  echo "  An Android emulator or Expo web on THIS machine still works:"
  echo "    emulator : EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:$PORT   (10.0.2.2 is the host from the emulator)"
  echo "    web      : EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:$PORT  (verified reachable from Windows)"
  exit 1
fi
echo
echo "  RESULT: READY — a phone on the same WiFi can reach http://$LAN:$PORT"
