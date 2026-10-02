#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export QRL_WALLET_ROOT="$ROOT"
export PYTHONPATH="$ROOT/linux${PYTHONPATH:+:$PYTHONPATH}"

exec python3 -m qrl_wallet "$@"
