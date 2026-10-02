const { callApiWithFailover, resolveNetworkEndpoints, DEFAULT_NETWORKS } = require('./grpc-client');
const ledger = require('./ledger');

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === 'string') {
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
      return Buffer.from(hex, 'hex');
    }
    return Buffer.from(value);
  }
  throw new Error('Unsupported buffer value');
}

function addressToBytes(address) {
  if (!address) {
    throw new Error('Address is required');
  }
  if (typeof address === 'string' && address.startsWith('Q')) {
    return Buffer.from(address.slice(1), 'hex');
  }
  return toBuffer(address);
}

function serializeValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = serializeValue(entry);
    }
    return out;
  }
  return value;
}

function targetFor(request = {}) {
  if (request.endpoint) return request.endpoint;
  if (request.network) return request.network;
  return 'testnet';
}

async function getAddressState(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetOptimizedAddressState', {
    address: addressToBytes(request.address),
  });
  return serializeValue(response);
}

async function getFullAddressState(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetAddressState', {
    address: addressToBytes(request.address),
  });
  return serializeValue(response);
}

async function getOTS(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetOTS', {
    address: addressToBytes(request.address),
  });
  return serializeValue(response);
}

async function getHeight(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetHeight', {});
  return serializeValue(response);
}

async function getStats(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetStats', {
    include_timeseries: false,
  });
  return serializeValue(response);
}

async function getObject(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetObject', {
    query: toBuffer(request.query),
  });
  return serializeValue(response);
}

async function transferCoins(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'TransferCoins', {
    master_addr: addressToBytes(request.fromAddress || request.master_addr),
    addresses_to: (request.addresses_to || []).map(addressToBytes),
    amounts: (request.amounts || []).map((amount) => String(amount)),
    fee: String(request.fee || 0),
    xmss_pk: toBuffer(request.xmss_pk || request.pk),
  });
  return serializeValue(response);
}

async function pushTransaction(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'PushTransaction', {
    transaction_signed: request.transaction_signed,
  });
  return serializeValue(response);
}

async function connect(request = {}) {
  const target = targetFor(request);
  const endpoints = target.includes(':') ? [target] : resolveNetworkEndpoints(target);
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      await callApiWithFailover(endpoint, 'GetHeight', {});
      return { connected: true, endpoint };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to connect to any node');
}

const handlers = {
  networks: async () => DEFAULT_NETWORKS,
  connect,
  status: getStats,
  getHeight,
  getAddressState,
  getFullAddressState,
  getOTS,
  getObject,
  transferCoins,
  pushTransaction,
  ledgerGetState: () => ledger.getState(),
  ledgerPublicKey: () => ledger.publicKey(),
  ledgerGetVersion: () => ledger.getVersion(),
  ledgerVerifyAddress: () => ledger.verifyAddress(),
};

module.exports = {
  handlers,
  serializeValue,
  addressToBytes,
};
