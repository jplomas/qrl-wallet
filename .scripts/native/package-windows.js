#!/usr/bin/env node
/**
 * Assemble a redistributable Windows folder (+ zip when tar/Compress available).
 *
 * Layout:
 *   .native/.dist/QRLWallet-win32-<arch>/
 *     QRLWallet.exe          # if built with native:build:windows
 *     QRLWallet.cmd          # launcher fallback
 *     runtime/               # bundled node + backend + UI
 *     README.txt
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROJECT_ROOT, DIST_ROOT } = require('./constants');

const arch = process.argv.find((a) => a.startsWith('--arch='))?.split('=')[1] || process.arch;
const runtimeSrc = path.join(DIST_ROOT, 'runtime', `win32-${arch}`);
const outDir = path.join(DIST_ROOT, `QRLWallet-win32-${arch}`);
const version = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed`);
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function ensureRuntime() {
  if (!fs.existsSync(path.join(runtimeSrc, 'bin', 'node.exe'))
    && !fs.existsSync(path.join(runtimeSrc, 'bin', 'node'))) {
    console.log('[native:package:windows] Runtime missing — building…');
    run('node', [
      path.join(PROJECT_ROOT, '.scripts', 'native', 'package-runtime.js'),
      '--platform=win32',
      `--arch=${arch}`,
    ], { cwd: PROJECT_ROOT });
  }
}

function main() {
  ensureRuntime();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  copyDir(runtimeSrc, path.join(outDir, 'runtime'));

  // Prefer a published .NET binary if present.
  const built = path.join(DIST_ROOT, 'windows');
  if (fs.existsSync(built)) {
    for (const name of fs.readdirSync(built)) {
      if (name.toLowerCase().endsWith('.exe') || name.toLowerCase().endsWith('.dll')) {
        fs.copyFileSync(path.join(built, name), path.join(outDir, name));
      }
    }
  }

  fs.writeFileSync(path.join(outDir, 'QRLWallet.cmd'), `@echo off
setlocal
set "HERE=%~dp0"
set "QRL_WALLET_ROOT=%HERE%runtime"
set "PATH=%HERE%runtime\\bin;%PATH%"
if exist "%HERE%QRLWallet.exe" (
  start "" "%HERE%QRLWallet.exe"
) else (
  echo Build the Windows UI with: npm run native:build:windows
  echo Then re-run: npm run native:package:windows
  pause
)
`);

  fs.writeFileSync(path.join(outDir, 'README.txt'), `QRL Wallet ${version} (Windows)

Double-click QRLWallet.exe (or QRLWallet.cmd).

No npm or Meteor required. WebView2 Runtime is required (preinstalled on
Windows 11; on Windows 10 install the Evergreen Runtime from Microsoft).

Build on Windows:
  npm run native:package:runtime -- --platform=win32
  npm run native:build:windows
  npm run native:package:windows
`);

  console.log(`[native:package:windows] Folder: ${outDir}`);
}

main();
