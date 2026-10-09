#!/usr/bin/env bash
# LOCAL ONLY: starts a loopback Anvil (chain 31337) and deploys Launch + Agent Accounts with the contracts checkout's
# script/local/DeployAgentLocal.s.sol, then copies the address book to fixtures/local-book.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="${MERCURIFI_CONTRACTS_DIR:-$ROOT/../../agent-contracts}"
PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
# Anvil's first default development account: a published key that means something only on a local Anvil.
export ANVIL_DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

if curl -s -o /dev/null --max-time 1 "$RPC"; then
  echo "something already listens on $RPC; run scripts/stop-local-chain.sh or set ANVIL_PORT" >&2
  exit 1
fi
anvil --host 127.0.0.1 --port "$PORT" --chain-id 31337 --silent >/dev/null 2>&1 &
echo $! > "$ROOT/.anvil.pid"
# Any failure below stops the Anvil this script started.
trap '"$ROOT/scripts/stop-local-chain.sh"' ERR
for _ in $(seq 1 50); do
  if curl -s --max-time 1 -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" | grep -q '"0x7a69"'; then
    break
  fi
  sleep 0.2
done
(
  cd "$CONTRACTS"
  bash script/build-trade-router.sh >/dev/null
  forge script script/local/DeployAgentLocal.s.sol:DeployAgentLocal --rpc-url "$RPC" --broadcast --slow -q
)
cp "$CONTRACTS/test-export/agent-local-31337.json" "$ROOT/fixtures/local-book.json"
# Leave the contracts worktree as it was: drop this run's gitignored broadcast and script-cache records and the export.
rm -rf "$CONTRACTS/broadcast/DeployAgentLocal.s.sol/31337" "$CONTRACTS/cache/DeployAgentLocal.s.sol/31337" \
  "$CONTRACTS/test-export/agent-local-31337.json"
rmdir "$CONTRACTS/broadcast/DeployAgentLocal.s.sol" "$CONTRACTS/broadcast" "$CONTRACTS/cache/DeployAgentLocal.s.sol" 2>/dev/null || true
trap - ERR
echo "Anvil pid $(cat "$ROOT/.anvil.pid") at $RPC; address book in fixtures/local-book.json"
