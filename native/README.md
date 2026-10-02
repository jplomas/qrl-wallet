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
QRL_TEST_MNEMONIC='…' npm run native:wallet-test
```

## CI secret

GitHub Actions workflow `.github/workflows/native-ci.yml` runs the smoke test on every relevant PR/push. The wallet unlock job runs only when repository secret `QRL_TEST_MNEMONIC` is set:

```bash
# from a machine with repo admin access:
gh secret set QRL_TEST_MNEMONIC --body "$(pbpaste)"   # or type/paste the testnet mnemonic
```

Or: repo **Settings → Secrets and variables → Actions → New repository secret** named `QRL_TEST_MNEMONIC`.
