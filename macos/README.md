# QRL Wallet — macOS Native Client

SwiftUI + WKWebView shell. Starts the shared loopback backend in `native/backend` and loads `native/ui`.

## Requirements

- macOS 13+
- Xcode 15+
- Node.js v22

## Development

```bash
npm install
npm run native:dev:macos
# on a Mac, open macos/QRLWallet.xcodeproj and run
```

## Build

```bash
cd macos && ./build.sh
```

## Security

- Backend bound to `127.0.0.1` only
- Navigation restricted to the local origin; other http(s) links open in Safari
- `window.__QRL_NATIVE_DESKTOP__` injected for desktop feature detection
