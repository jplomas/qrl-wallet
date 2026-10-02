#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/.native/.dist/linux"
APP_SRC="$ROOT/linux/qrl_wallet"

mkdir -p "$DIST/bin" "$DIST/qrl_wallet"

cp -a "$APP_SRC/." "$DIST/qrl_wallet/"
cat > "$DIST/bin/qrl-wallet" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"

# Walk up from the dist tree until we find the repo package.json.
if [[ -z "${QRL_WALLET_ROOT:-}" ]]; then
  probe="$HERE"
  while [[ "$probe" != "/" ]]; do
    if [[ -f "$probe/package.json" && -d "$probe/imports" ]]; then
      export QRL_WALLET_ROOT="$probe"
      break
    fi
    probe="$(dirname "$probe")"
  done
fi

exec python3 -m qrl_wallet "$@"
EOF
chmod +x "$DIST/bin/qrl-wallet"

# Keep a convenience launcher at the dist root.
cp "$DIST/bin/qrl-wallet" "$DIST/qrl-wallet"
chmod +x "$DIST/qrl-wallet"

echo "Built $DIST"
