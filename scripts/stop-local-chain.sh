#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.anvil.pid" ]; then
  kill "$(cat "$ROOT/.anvil.pid")" 2>/dev/null || true
  rm -f "$ROOT/.anvil.pid"
fi
