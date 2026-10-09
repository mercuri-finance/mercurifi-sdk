#!/usr/bin/env bash
# Stops the Anvil that scripts/local-chain.sh started on a port: scripts/stop-local-chain.sh [port] (default ANVIL_PORT
# or 8545). Kills only a process that is still anvil, so a recycled pid is never hit.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-${ANVIL_PORT:-8545}}"
PIDFILE="$ROOT/.anvil-${PORT}.pid"
[ -f "$PIDFILE" ] || exit 0
pid="$(cat "$PIDFILE")"
if [[ "$pid" =~ ^[0-9]+$ ]] && ps -p "$pid" -o comm= 2>/dev/null | grep -q anvil; then
  kill "$pid" 2>/dev/null || true
fi
rm -f "$PIDFILE"
