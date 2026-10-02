# QRL Wallet — Windows Native Client

WPF + WebView2 shell. Starts the shared loopback backend in `native/backend` and loads `native/ui`.

## Requirements

- Windows 10/11
- .NET 8 SDK
- WebView2 Runtime
- Node.js v22

## Development

```powershell
npm install
npm run native:dev:windows
dotnet run --project windows/QRLWallet
```

## Build

```powershell
./windows/build.ps1
```

## Security

- Backend bound to `127.0.0.1` only
- Navigation restricted to the local origin; other links open in the system browser
- Desktop feature flag injected into the WebView
