const fs = require('fs');
const util = require('util');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoloader = require('@grpc/proto-loader');
const tmp = require('tmp');
const CryptoJS = require('crypto-js');
const { QRLPROTO_SHA256 } = require('@theqrl/qrl-proto-sha256');
const { PROTO_DIR, ALLOW_UNCHECKSUMMED, DEFAULT_NETWORKS } = require('./config');

const QRLPROTO_SHA256_OVERRIDES = [
  {
    version: '4.0.0 python',
    protoSha256: '0d70a3372c4668a1bf4fd42983ae01f2e0fb54b4030b808bbea78e5adadb23f0',
    objectSha256: 'b1de7b4968bb3605a00670d9c946b993017c17d5cd12d8fedb1ac5c47ea2ef76',
    walletProto: 'b1de7b4968bb3605a00670d9c946b993017c17d5cd12d8fedb1ac5c47ea2ef76',
  },
  {
    version: '4.0.1 python',
    protoSha256: '0d70a3372c4668a1bf4fd42983ae01f2e0fb54b4030b808bbea78e5adadb23f0',
    objectSha256: '14369669c53fa09df90204b47d4b62cabdfa618485849b3210c4316fd36be149',
    walletProto: '14369669c53fa09df90204b47d4b62cabdfa618485849b3210c4316fd36be149',
  },
];

const TRUSTED = [...QRLPROTO_SHA256, ...QRLPROTO_SHA256_OVERRIDES];
const clients = new Map();

function normalizeEndpoint(endpoint) {
  return typeof endpoint === 'string' ? endpoint.trim() : '';
}

function isConfiguredEndpoint(endpoint) {
  const normalized = normalizeEndpoint(endpoint);
  return DEFAULT_NETWORKS.some((network) => (network.nodes || []).some(
    (node) => normalizeEndpoint(node.grpc) === normalized,
  ));
}

function endpointDenialReason(endpoint) {
  if (isConfiguredEndpoint(endpoint)) {
    return null;
  }
  // Native desktop defaults to allowlist-only for SSRF safety.
  return 'Custom gRPC endpoints are disabled in the native wallet';
}

function hashTrusted(kind, value) {
  return TRUSTED.some((entry) => entry[kind] === value || entry.walletProto === value);
}

function loadGrpcClient(endpoint) {
  const normalized = normalizeEndpoint(endpoint);
  const denial = endpointDenialReason(normalized);
  if (denial) {
    return Promise.reject(new Error(denial));
  }
  if (clients.has(normalized)) {
    return Promise.resolve(clients.get(normalized));
  }

  const options = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  };

  return protoloader
    .load(path.join(PROTO_DIR, 'qrlbase.proto'), options)
    .then((packageDefinitionBase) => {
      const baseGrpcObject = grpc.loadPackageDefinition(packageDefinitionBase);
      const baseClient = new baseGrpcObject.qrl.Base(
        normalized,
        grpc.credentials.createInsecure(),
      );

      return new Promise((resolve, reject) => {
        baseClient.getNodeInfo({}, (err, res) => {
          if (err) {
            reject(err);
            return;
          }

          const protoFile = tmp.fileSync({
            mode: 0o644,
            prefix: 'qrl-',
            postfix: '.proto',
            discardDescriptor: true,
          });

          const cleanup = () => {
            try {
              protoFile.removeCallback();
            } catch (_) {
              // ignore
            }
          };

          fs.writeFile(protoFile.name, res.grpcProto, (writeErr) => {
            if (writeErr) {
              cleanup();
              reject(writeErr);
              return;
            }

            fs.readFile(protoFile.name, (readErr, contents) => {
              if (readErr) {
                cleanup();
                reject(readErr);
                return;
              }

              const calculatedProtoHash = CryptoJS.SHA256(
                CryptoJS.lib.WordArray.create(contents),
              ).toString(CryptoJS.enc.Hex);

              const protoOk = hashTrusted('protoSha256', calculatedProtoHash) || ALLOW_UNCHECKSUMMED;
              if (!protoOk) {
                cleanup();
                reject(new Error(`Invalid qrl.proto shasum: ${calculatedProtoHash}`));
                return;
              }

              protoloader
                .load(protoFile.name, options)
                .then((packageDefinition) => {
                  const grpcObject = grpc.loadPackageDefinition(packageDefinition);
                  const grpcObjectString = JSON.stringify(
                    util.inspect(grpcObject, { showHidden: true, depth: 4 }),
                  );
                  const calculatedObjectHash = CryptoJS.SHA256(
                    CryptoJS.lib.WordArray.create(grpcObjectString),
                  ).toString(CryptoJS.enc.Hex);

                  const objectOk = hashTrusted('objectSha256', calculatedObjectHash) || ALLOW_UNCHECKSUMMED;
                  if (!objectOk) {
                    cleanup();
                    reject(new Error(`Invalid qrl.proto object shasum: ${calculatedObjectHash}`));
                    return;
                  }

                  const publicApi = new grpcObject.qrl.PublicAPI(
                    normalized,
                    grpc.credentials.createInsecure(),
                  );
                  clients.set(normalized, publicApi);
                  cleanup();
                  resolve(publicApi);
                })
                .catch((loadErr) => {
                  cleanup();
                  reject(loadErr);
                });
            });
          });
        });
      });
    });
}

function callApi(endpoint, method, request = {}) {
  return loadGrpcClient(endpoint).then((client) => new Promise((resolve, reject) => {
    if (typeof client[method] !== 'function') {
      reject(new Error(`Unknown gRPC method: ${method}`));
      return;
    }
    client[method](request, (err, response) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(response);
    });
  }));
}

function resolveNetworkEndpoints(networkId) {
  const network = DEFAULT_NETWORKS.find((entry) => entry.id === networkId)
    || DEFAULT_NETWORKS.find((entry) => entry.id === 'testnet');
  if (!network || !network.nodes.length) {
    throw new Error(`Unknown network: ${networkId}`);
  }
  return network.nodes.map((node) => node.grpc);
}

function resolveNetworkEndpoint(networkId) {
  return resolveNetworkEndpoints(networkId)[0];
}

async function callApiWithFailover(networkOrEndpoint, method, request = {}) {
  const endpoints = networkOrEndpoint.includes(':')
    ? [networkOrEndpoint]
    : resolveNetworkEndpoints(networkOrEndpoint);

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      return await callApi(endpoint, method, request);
    } catch (error) {
      lastError = error;
      // Drop a failed client so the next attempt can rebuild.
      clients.delete(normalizeEndpoint(endpoint));
    }
  }
  throw lastError || new Error(`All nodes failed for ${method}`);
}

module.exports = {
  DEFAULT_NETWORKS,
  callApi,
  callApiWithFailover,
  endpointDenialReason,
  loadGrpcClient,
  normalizeEndpoint,
  resolveNetworkEndpoint,
  resolveNetworkEndpoints,
};
