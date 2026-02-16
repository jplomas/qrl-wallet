#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { build, Platform, Arch } = require('electron-builder');
const pkg = require('../package.json');

function parseArgs(argv) {
  return argv.reduce((acc, arg) => {
    if (!arg.startsWith('--')) {
      return acc;
    }

    const [key, value] = arg.replace(/^--/, '').split('=');
    acc[key] = value === undefined ? true : value;
    return acc;
  }, {});
}

function die(message) {
  console.error(`[installer] ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const platform = args.platform || process.platform;
const arch = args.arch || process.env.BUILD_ARCH || process.arch;

const platformMap = {
  darwin: {
    targetPlatform: Platform.MAC,
    target: 'dmg',
  },
  win32: {
    targetPlatform: Platform.WINDOWS,
    // NSIS is the current maintained default in electron-builder and works for x64/arm64.
    target: 'nsis',
  },
  linux: {
    targetPlatform: Platform.LINUX,
    target: 'deb',
  },
};

const archMap = {
  x64: Arch.x64,
  arm64: Arch.arm64,
};

if (!platformMap[platform]) {
  die(`Unsupported platform "${platform}". Expected one of: ${Object.keys(platformMap).join(', ')}`);
}

if (!archMap[arch]) {
  die(`Unsupported arch "${arch}". Expected one of: ${Object.keys(archMap).join(', ')}`);
}

const distRoot = path.resolve('.electrify/.dist');
const prepackagedRoot = path.join(distRoot, `QRLWallet-${platform}-${arch}`);
const prepackaged = platform === 'darwin'
  ? path.join(prepackagedRoot, 'QRLWallet.app')
  : prepackagedRoot;
const outputDir = path.join(distRoot, 'installers');

if (!fs.existsSync(prepackaged)) {
  die(`Prepackaged app not found: ${prepackaged}. Run electrify package first.`);
}

fs.mkdirSync(outputDir, { recursive: true });

const targetConfig = platformMap[platform];
const targets = targetConfig.targetPlatform.createTarget([targetConfig.target], archMap[arch]);

const builderConfig = {
  appId: 'org.theqrl.wallet',
  productName: 'QRLWallet',
  executableName: 'QRLWallet',
  artifactName: `QRLWallet-${pkg.version}-${platform}-${arch}.${'${ext}'}`,
  directories: {
    output: outputDir,
  },
  mac: {
    icon: path.resolve('.electrify/assets/qrl.icns'),
    category: 'public.app-category.finance',
  },
  dmg: {
    title: 'QRL Wallet Installer',
    background: path.resolve('.electrify/assets/dmgBackground.png'),
  },
  win: {
    icon: path.resolve('.electrify/assets/qrl.ico'),
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
  linux: {
    category: 'Finance',
    maintainer: 'The QRL Contributors',
    synopsis: 'QRL Wallet',
    description: 'Quantum Resistant Ledger desktop wallet.',
  },
};

console.log(`[installer] building ${targetConfig.target} from ${prepackaged}`);

build({
  prepackaged,
  targets,
  config: builderConfig,
  publish: 'never',
}).then((artifacts) => {
  artifacts.forEach((artifact) => {
    console.log(`[installer] created ${artifact}`);
  });
}).catch((error) => {
  die(error && error.message ? error.message : String(error));
});
