#!/usr/bin/env bash
# LOCAL ONLY: starts a loopback Anvil (chain 31337) and deploys Launch + Agent Accounts with the contracts checkout's
# script/local/DeployAgentLocal.s.sol (MERCURIFI_CONTRACTS_DIR, required), then copies the address book to fixtures/local-book-<port>.json.
# Port: ANVIL_PORT (default 8545). The test tiers read the same ANVIL_PORT (or ANVIL_RPC, whose port names the book).
# Stop it with: scripts/stop-local-chain.sh [port]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${MERCURIFI_CONTRACTS_DIR:-}" ]; then
  echo "set MERCURIFI_CONTRACTS_DIR to the agent contracts checkout (the one with script/local/DeployAgentLocal.s.sol)" >&2
  exit 2
fi
CONTRACTS="$MERCURIFI_CONTRACTS_DIR"
PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
PIDFILE="$ROOT/.anvil-${PORT}.pid"
BOOK="$ROOT/fixtures/local-book-${PORT}.json"
EXPORT="test-export/agent-local-31337.json"
# Anvil's first default development account: a published key that means something only on a local Anvil.
export ANVIL_DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "ANVIL_PORT must be a number" >&2; exit 1; }
if [ -f "$PIDFILE" ]; then
  echo "$PIDFILE exists: an Anvil from this script may still run on port $PORT; run scripts/stop-local-chain.sh $PORT" >&2
  exit 1
fi
if curl -s -o /dev/null --max-time 1 "$RPC"; then
  echo "something already listens on $RPC; run scripts/stop-local-chain.sh $PORT or set ANVIL_PORT" >&2
  exit 1
fi
# The deploy script always writes the same export path; a leftover means another run is in progress (or was killed).
if [ -e "$CONTRACTS/$EXPORT" ]; then
  echo "$CONTRACTS/$EXPORT exists: another local-chain run may be deploying; remove it if not" >&2
  exit 1
fi

# Gitignored paths the forge run may create in the contracts checkout; only the entries that did not exist before are
# removed afterwards, so the checkout is left exactly as found. The snapshot covers this script's own outputs only: the
# bare broadcast/ directory entry (never its other children) and broadcast/DeployAgentLocal.s.sol. Any other broadcast,
# such as a real deployment's record read by write-agent-accounts-record.py, is never listed and so never removed,
# even when it appears while this script runs.
snapshot() {
  (
    cd "$CONTRACTS" || exit 0
    { find broadcast -maxdepth 0; find broadcast/DeployAgentLocal.s.sol cache/DeployAgentLocal.s.sol "$EXPORT"; } \
      2>/dev/null | LC_ALL=C sort
  ) || true
}
BEFORE="$(snapshot)"
started=0
ok=0
ANVIL_PID=""
cleanup() {
  local created
  created="$(LC_ALL=C comm -13 <(printf '%s\n' "$BEFORE") <(snapshot) | LC_ALL=C sort -r)"
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if [ -d "$CONTRACTS/$path" ]; then
      # rmdir only: a created directory goes once empty, so broadcast/ survives if anything else now lives in it.
      rmdir "$CONTRACTS/$path" 2>/dev/null || true
    else
      rm -f "$CONTRACTS/$path"
    fi
  done <<<"$created"
  if [ "$started" = 1 ] && [ "$ok" != 1 ]; then
    if [ -f "$PIDFILE" ]; then
      "$ROOT/scripts/stop-local-chain.sh" "$PORT"
    elif [ -n "$ANVIL_PID" ]; then
      # Interrupted between the launch and the pid file write: stop the child directly.
      kill "$ANVIL_PID" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

anvil --host 127.0.0.1 --port "$PORT" --chain-id 31337 --silent >/dev/null 2>&1 &
ANVIL_PID=$!
started=1
echo "$ANVIL_PID" > "$PIDFILE"
ready() {
  curl -s --max-time 1 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" | grep -q '"0x7a69"'
}
for _ in $(seq 1 50); do
  ready && break
  sleep 0.2
done
if ! ready; then
  echo "Anvil did not answer as chain 31337 on $RPC within 10 s" >&2
  exit 1
fi
# Deploy only to an Anvil: the node must name itself anvil (web3_clientVersion "anvil/v…"), not merely answer 31337.
client="$(curl -s --max-time 2 -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":2,"method":"web3_clientVersion","params":[]}' "$RPC" || true)"
if ! printf '%s' "$client" | grep -Eq '"result"[[:space:]]*:[[:space:]]*"anvil/'; then
  echo "the node on $RPC is not Anvil (web3_clientVersion did not start with anvil/); refusing to deploy" >&2
  exit 1
fi
(
  cd "$CONTRACTS"
  bash script/build-trade-router.sh >/dev/null
  forge script script/local/DeployAgentLocal.s.sol:DeployAgentLocal --rpc-url "$RPC" --broadcast --slow -q
)
cp "$CONTRACTS/$EXPORT" "$BOOK"
ok=1
echo "Anvil pid $(cat "$PIDFILE") at $RPC; address book in fixtures/local-book-${PORT}.json"
