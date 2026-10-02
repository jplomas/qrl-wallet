#!/usr/bin/env node
/**
 * Assemble a redistributable Linux app directory + .tar.gz
 *
 * Layout:
 *   .native/.dist/QRLWallet-linux-<arch>/
 *     QRLWallet                 # double-click / PATH launcher
 *     qrl-wallet.desktop
 *     README.txt
 *     runtime/                  # bundled node + backend + UI + assets
 *     linux/qrl_wallet/         # GTK WebView shell (needs system WebKitGTK)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROJECT_ROOT, DIST_ROOT } = require('./constants');

const arch = process.argv.find((a) => a.startsWith('--arch='))?.split('=')[1] || process.arch;
const runtimeSrc = path.join(DIST_ROOT, 'runtime', `linux-${arch}`);
const outDir = path.join(DIST_ROOT, `QRLWallet-linux-${arch}`);
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
    console.log('[native:package:linux] Runtime missing — building…');
    run('node', [
      path.join(PROJECT_ROOT, '.scripts', 'native', 'package-runtime.js'),
      '--platform=linux',
      `--arch=${arch}`,
    ], { cwd: PROJECT_ROOT });
  }
}

function main() {
  ensureRuntime();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  copyDir(runtimeSrc, path.join(outDir, 'runtime'));
  copyDir(
    path.join(PROJECT_ROOT, 'linux', 'qrl_wallet'),
    path.join(outDir, 'linux', 'qrl_wallet'),
  );

  const launcher = path.join(outDir, 'QRLWallet');
  fs.writeFileSync(launcher, `#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export QRL_WALLET_ROOT="$HERE/runtime"
export PYTHONPATH="$HERE/linux\${PYTHONPATH:+:\$PYTHONPATH}"
export PATH="$HERE/runtime/bin:$PATH"

if ! python3 -c "import gi; gi.require_version('Gtk','3.0')" 2>/dev/null; then
  echo "QRL Wallet needs GTK 3 + WebKitGTK."
  echo "On Debian/Ubuntu: sudo apt-get install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1"
  exit 1
fi

exec python3 -m qrl_wallet "$@"
`);
  fs.chmodSync(launcher, 0o755);

  fs.writeFileSync(path.join(outDir, 'qrl-wallet.desktop'), `[Desktop Entry]
Type=Application
Name=QRL Wallet
Comment=Quantum Resistant Ledger desktop wallet
Exec=${outDir}/QRLWallet
Path=${outDir}
Icon=${outDir}/runtime/public/img/icon.svg
Terminal=false
Categories=Finance;Network;
StartupWMClass=QRL Wallet
`);

  fs.writeFileSync(path.join(outDir, 'README.txt'), `QRL Wallet ${version} (Linux)

Double-click or run:

  ./QRLWallet

No npm or Meteor required. The app bundles Node and the wallet UI.

System packages required once:

  sudo apt-get install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1

Optional desktop entry: copy qrl-wallet.desktop into ~/.local/share/applications/
and adjust Exec/Icon paths.
`);

  const tarball = path.join(DIST_ROOT, `QRLWallet-linux-${arch}-v${version}.tar.gz`);
  fs.rmSync(tarball, { force: true });
  run('tar', ['-czf', tarball, '-C', DIST_ROOT, path.basename(outDir)]);

  console.log(`[native:package:linux] App dir: ${outDir}`);
  console.log(`[native:package:linux] Archive: ${tarball}`);
}

main();
