# Native desktop (no Electron, no Meteor)

Shared local stack used by the `macos/`, `windows/`, and `linux/` shells.

## Layout

- `native/backend` — loopback-only Node HTTP API + static file server
- `native/ui` — lightweight wallet UI (open/create/balance/transfer)
- Root `public/` — shared assets (`qrllib`, images, fonts)

Platform shells start the backend on `127.0.0.1`, then load it in an OS WebView.

## Security model

- Bind **127.0.0.1 only** (refuses non-loopback hosts)
- Reject non-local `Host` / `Origin` (DNS-rebinding protection)
- gRPC targets are **allowlisted** to configured mainnet/testnet nodes
- Wallet seeds and XMSS signing stay in the renderer / `qrllib` WASM — the backend never sees mnemonics
- CSP + `X-Frame-Options: DENY` on served pages
- WebViews open external links in the system browser

## Run

```bash
npm run native:backend          # http://127.0.0.1:51888
npm run native:dev:linux        # GTK + WebKit shell
npm run native:smoke-test
npm run native:wallet-test      # unlocks the provided testnet mnemonic in headless Chrome
```
