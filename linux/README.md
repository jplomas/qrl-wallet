# QRL Wallet — Linux Native Client

GTK 3 + WebKitGTK shell. Starts the shared loopback backend in `native/backend` and loads `native/ui`.

## Requirements

- Python 3.10+
- `gir1.2-gtk-3.0` and `gir1.2-webkit2-4.1` (or 4.0)
- Node.js v22

```bash
sudo apt-get install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1
```

## Development

```bash
npm install
npm run native:dev:linux
```

## Build

```bash
cd linux && ./build.sh
```

## Security

- Backend bound to `127.0.0.1` only
- Navigation restricted to the local origin; external links use `xdg-open`
- Desktop feature flag injected into WebKit
