#!/usr/bin/env node
/**
 * Build a redistributable runtime tree:
 *   .native/.dist/runtime/<platform>-<arch>/
 *     bin/node[.exe]
 *     native/{backend,ui}
 *     public/{workers,img,fonts,...}
 *     private/qrlbase.proto
 *     package.json + node_modules (backend deps only)
 *
 * End users never run npm — platform packagers wrap this tree in an app/installer.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  PROJECT_ROOT,
  DIST_ROOT,
} = require('./constants');

const platform = process.argv.find((a) => a.startsWith('--platform='))?.split('=')[1]
  || process.platform;
const arch = process.argv.find((a) => a.startsWith('--arch='))?.split('=')[1]
  || process.arch;

const outRoot = path.join(DIST_ROOT, 'runtime', `${platform}-${arch}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      copyDir(from, to);
    } else {
      copyFile(from, to);
    }
  }
}

function nodeVersion() {
  const nvmrc = path.join(PROJECT_ROOT, '.nvmrc');
  if (fs.existsSync(nvmrc)) {
    const raw = fs.readFileSync(nvmrc, 'utf8').trim().replace(/^v/, '');
    // ".nvmrc" may be major-only ("22"); prefer the exact running Node for ABI match.
    if (/^\d+\.\d+\.\d+$/.test(raw)) {
      return raw;
    }
  }
  return process.versions.node;
}

function platformNodeArtifact(targetPlatform, targetArch) {
  const version = nodeVersion();
  const archMap = {
    x64: 'x64',
    arm64: 'arm64',
    ia32: 'x86',
  };
  const nodeArch = archMap[targetArch] || targetArch;

  if (targetPlatform === 'linux') {
    return {
      url: `https://nodejs.org/dist/v${version}/node-v${version}-linux-${nodeArch}.tar.gz`,
      binaryPath: `node-v${version}-linux-${nodeArch}/bin/node`,
      kind: 'tar.gz',
    };
  }
  if (targetPlatform === 'darwin') {
    return {
      url: `https://nodejs.org/dist/v${version}/node-v${version}-darwin-${nodeArch}.tar.gz`,
      binaryPath: `node-v${version}-darwin-${nodeArch}/bin/node`,
      kind: 'tar.gz',
    };
  }
  if (targetPlatform === 'win32') {
    return {
      url: `https://nodejs.org/dist/v${version}/node-v${version}-win-${nodeArch}.zip`,
      binaryPath: `node-v${version}-win-${nodeArch}/node.exe`,
      kind: 'zip',
    };
  }
  throw new Error(`Unsupported platform for Node download: ${targetPlatform}`);
}

function acquireNodeBinary(destDir, targetPlatform, targetArch) {
  fs.mkdirSync(destDir, { recursive: true });
  const destName = targetPlatform === 'win32' ? 'node.exe' : 'node';
  const dest = path.join(destDir, destName);

  // Same platform/arch: still prefer an official tarball for redistribution.
  const artifact = platformNodeArtifact(targetPlatform, targetArch);
  const cacheDir = path.join(DIST_ROOT, 'cache', 'node');
  fs.mkdirSync(cacheDir, { recursive: true });
  const archiveName = path.basename(artifact.url);
  const archivePath = path.join(cacheDir, archiveName);

  if (!fs.existsSync(archivePath)) {
    console.log(`[native:package-runtime] Downloading ${artifact.url}`);
    run('curl', ['-fsSL', artifact.url, '-o', archivePath]);
  }

  const extractDir = path.join(cacheDir, `${targetPlatform}-${targetArch}-extract`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  if (artifact.kind === 'tar.gz') {
    run('tar', ['-xzf', archivePath, '-C', extractDir]);
  } else {
    run('unzip', ['-q', archivePath, '-d', extractDir]);
  }

  const extracted = path.join(extractDir, artifact.binaryPath);
  if (!fs.existsSync(extracted)) {
    throw new Error(`Node binary not found in archive: ${extracted}`);
  }
  fs.copyFileSync(extracted, dest);
  if (targetPlatform !== 'win32') {
    fs.chmodSync(dest, 0o755);
  }
  console.log(`[native:package-runtime] Bundled official Node ${nodeVersion()} → ${dest}`);
  return dest;
}

function main() {
  console.log(`[native:package-runtime] Building ${outRoot}`);
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });

  // Backend + UI
  copyDir(path.join(PROJECT_ROOT, 'native', 'backend'), path.join(outRoot, 'native', 'backend'));
  copyDir(path.join(PROJECT_ROOT, 'native', 'ui'), path.join(outRoot, 'native', 'ui'));

  // Shared assets used by the UI
  const publicSrc = path.join(PROJECT_ROOT, 'public');
  const publicDest = path.join(outRoot, 'public');
  for (const name of ['workers', 'img', 'fonts', 'tailwind-output.css']) {
    const src = path.join(publicSrc, name);
    const dest = path.join(publicDest, name);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) copyDir(src, dest);
    else copyFile(src, dest);
  }

  // Proto bootstrap file
  copyFile(
    path.join(PROJECT_ROOT, 'private', 'qrlbase.proto'),
    path.join(outRoot, 'private', 'qrlbase.proto'),
  );

  // Root marker + version
  const rootPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const backendPkg = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'native', 'backend', 'package.json'), 'utf8'),
  );
  backendPkg.version = rootPkg.version;
  fs.writeFileSync(
    path.join(outRoot, 'package.json'),
    JSON.stringify({
      name: 'qrl-wallet-native-runtime',
      version: rootPkg.version,
      private: true,
      dependencies: backendPkg.dependencies,
    }, null, 2),
  );

  // Install production deps into the runtime tree
  console.log('[native:package-runtime] Installing production backend dependencies…');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: outRoot });

  acquireNodeBinary(path.join(outRoot, 'bin'), platform, arch);

  // Convenience launcher for the backend alone (debugging packaged builds)
  const launcher = platform === 'win32'
    ? path.join(outRoot, 'start-backend.cmd')
    : path.join(outRoot, 'start-backend.sh');
  if (platform === 'win32') {
    fs.writeFileSync(launcher, `@echo off\r\nset BIND_IP=127.0.0.1\r\n"%~dp0bin\\node.exe" "%~dp0native\\backend\\server.js"\r\n`);
  } else {
    fs.writeFileSync(launcher, `#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export QRL_WALLET_ROOT="$HERE"
export BIND_IP="\${BIND_IP:-127.0.0.1}"
exec "$HERE/bin/node" "$HERE/native/backend/server.js"
`);
    fs.chmodSync(launcher, 0o755);
  }

  console.log(`[native:package-runtime] Ready: ${outRoot}`);
}

main();
