#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/.native/.dist/macos"
PROJECT="$ROOT/macos/QRLWallet.xcodeproj"
SCHEME="QRLWallet"
CONFIG="${1:-Release}"

mkdir -p "$DIST"

xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -derivedDataPath "$ROOT/.native/tmp/xcode-derived" \
  CONFIGURATION_BUILD_DIR="$DIST" \
  build

echo "Built $DIST/QRLWallet.app"
