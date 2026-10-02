#!/usr/bin/env node
/**
 * Assemble a redistributable macOS .app skeleton with bundled runtime.
 *
 * On a Mac with Xcode, prefer: npm run native:package:macos
 * which builds the Swift UI then embeds runtime into Contents/Resources.
 *
 * In CI / non-Mac environments this still produces:
 *   .native/.dist/QRLWallet-darwin-<arch>/QRLWallet.app/Contents/Resources/runtime
 * plus a helper script noting that MacOS/QRLWallet must be built with Xcode.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROJECT_ROOT, DIST_ROOT } = require('./constants');

const arch = process.argv.find((a) => a.startsWith('--arch='))?.split('=')[1] || process.arch;
const runtimeSrc = path.join(DIST_ROOT, 'runtime', `darwin-${arch}`);
const outRoot = path.join(DIST_ROOT, `QRLWallet-darwin-${arch}`);
const appPath = path.join(outRoot, 'QRLWallet.app');
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
  if (!fs.existsSync(path.join(runtimeSrc, 'bin', 'node'))) {
    console.log('[native:package:macos] Runtime missing — building…');
    run('node', [
      path.join(PROJECT_ROOT, '.scripts', 'native', 'package-runtime.js'),
      '--platform=darwin',
      `--arch=${arch}`,
    ], { cwd: PROJECT_ROOT });
  }
}

function writeInfoPlist(plistPath) {
  fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>QRLWallet</string>
  <key>CFBundleIdentifier</key><string>org.theqrl.QRLWallet</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>QRL Wallet</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);
}

function main() {
  ensureRuntime();
  fs.rmSync(outRoot, { recursive: true, force: true });

  const contents = path.join(appPath, 'Contents');
  const macosDir = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });

  copyDir(runtimeSrc, path.join(resources, 'runtime'));
  writeInfoPlist(path.join(contents, 'Info.plist'));

  // If an Xcode-built binary already exists from native:build:macos, embed it.
  const builtApp = path.join(DIST_ROOT, 'macos', 'QRLWallet.app');
  const builtBinary = path.join(builtApp, 'Contents', 'MacOS', 'QRLWallet');
  if (fs.existsSync(builtBinary)) {
    fs.copyFileSync(builtBinary, path.join(macosDir, 'QRLWallet'));
    fs.chmodSync(path.join(macosDir, 'QRLWallet'), 0o755);
    console.log('[native:package:macos] Embedded Xcode-built QRLWallet binary');
  } else {
    // Placeholder launcher for packaging dry-runs off-Mac.
    const stub = path.join(macosDir, 'QRLWallet');
    fs.writeFileSync(stub, `#!/bin/bash
echo "Build the Swift UI on macOS with: npm run native:build:macos"
echo "Then re-run: npm run native:package:macos"
exit 1
`);
    fs.chmodSync(stub, 0o755);
    console.log('[native:package:macos] No Xcode binary found — stub launcher written');
  }

  fs.writeFileSync(path.join(outRoot, 'README.txt'), `QRL Wallet ${version} (macOS)

Open QRLWallet.app — no Terminal, npm, or Meteor required.

Build on a Mac:
  npm run native:package:runtime -- --platform=darwin
  npm run native:build:macos
  npm run native:package:macos
`);

  console.log(`[native:package:macos] App: ${appPath}`);
}

main();
