#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_ROOT, DEFAULT_PORT } = require('./constants');

const platform = process.argv[2] || process.platform;
const env = {
  ...process.env,
  QRL_WALLET_ROOT: PROJECT_ROOT,
  BIND_IP: '127.0.0.1',
  PORT: String(process.env.PORT || DEFAULT_PORT),
};

function startBackend() {
  return spawn('node', [path.join(PROJECT_ROOT, 'native', 'backend', 'server.js')], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });
}

if (platform === 'linux') {
  const backend = startBackend();
  // Give the backend a moment, then open the GTK shell pointed at it.
  // The Linux shell also starts its own backend; prefer that path.
  backend.kill();
  const result = spawn(path.join(PROJECT_ROOT, 'linux', 'run.sh'), [], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });
  result.on('exit', (code) => process.exit(code || 0));
} else if (platform === 'darwin' || platform === 'macos') {
  console.log('[native:dev] Starting loopback backend for macOS WebView development…');
  console.log('[native:dev] Open macos/QRLWallet.xcodeproj on a Mac, or browse http://127.0.0.1:' + env.PORT);
  const backend = startBackend();
  backend.on('exit', (code) => process.exit(code || 0));
} else if (platform === 'win32' || platform === 'windows') {
  console.log('[native:dev] Starting loopback backend for Windows WebView2 development…');
  console.log('[native:dev] Build windows/QRLWallet with .NET 8, or browse http://127.0.0.1:' + env.PORT);
  const backend = startBackend();
  backend.on('exit', (code) => process.exit(code || 0));
} else {
  console.error(`[native:dev] Unsupported platform: ${platform}`);
  process.exit(1);
}
