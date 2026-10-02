const path = require('path');
const fs = require('fs');

function resolveProjectRoot() {
  if (process.env.QRL_WALLET_ROOT) {
    return path.resolve(process.env.QRL_WALLET_ROOT);
  }

  // Packaged runtime: this file lives at <runtime>/native/backend/config.js
  // and the runtime root contains package.json + public/ + private/.
  const runtimeCandidate = path.resolve(__dirname, '../..');
  if (
    fs.existsSync(path.join(runtimeCandidate, 'public'))
    && fs.existsSync(path.join(runtimeCandidate, 'private', 'qrlbase.proto'))
    && fs.existsSync(path.join(runtimeCandidate, 'native', 'ui'))
  ) {
    return runtimeCandidate;
  }

  // Dev checkout: native/backend -> repo root
  return path.resolve(__dirname, '../..');
}

const PROJECT_ROOT = resolveProjectRoot();
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 51888;

const DEFAULT_NETWORKS = [
  {
    id: 'mainnet',
    name: 'Mainnet',
    explorerUrl: 'https://explorer.theqrl.org',
    nodes: [
      { id: 'mainnet-1', grpc: 'mainnet-1.automated.theqrl.org:19009' },
      { id: 'mainnet-2', grpc: 'mainnet-2.automated.theqrl.org:19009' },
      { id: 'mainnet-3', grpc: 'mainnet-3.automated.theqrl.org:19009' },
      { id: 'mainnet-4', grpc: 'mainnet-4.automated.theqrl.org:19009' },
    ],
  },
  {
    id: 'testnet',
    name: 'Testnet',
    explorerUrl: 'https://testnet-explorer.theqrl.org',
    nodes: [
      { id: 'testnet-1', grpc: 'testnet-1.automated.theqrl.org:29009' },
      { id: 'testnet-2', grpc: 'testnet-2.automated.theqrl.org:29009' },
      { id: 'testnet-3', grpc: 'testnet-3.automated.theqrl.org:29009' },
      { id: 'testnet-4', grpc: 'testnet-4.automated.theqrl.org:29009' },
    ],
  },
];

module.exports = {
  DEFAULT_NETWORKS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PROJECT_ROOT,
  PROTO_DIR: path.join(PROJECT_ROOT, 'private'),
  UI_DIR: path.join(PROJECT_ROOT, 'native', 'ui'),
  PUBLIC_DIR: path.join(PROJECT_ROOT, 'public'),
  // Desktop-local only. Never bind 0.0.0.0.
  BIND_HOST: process.env.BIND_IP || DEFAULT_HOST,
  PORT: Number(process.env.PORT || DEFAULT_PORT),
  ALLOW_UNCHECKSUMMED: process.env.QRL_ALLOW_UNCHECKSUMMED === 'true',
};
