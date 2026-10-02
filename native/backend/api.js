const QRCode = require('qrcode');
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

function reviveSignedTransaction(tx = {}) {
  const revived = { ...tx };
  if (revived.public_key != null) revived.public_key = toBuffer(revived.public_key);
  if (revived.signature != null) revived.signature = toBuffer(revived.signature);
  if (revived.transaction_hash != null) {
    revived.transaction_hash = toBuffer(revived.transaction_hash);
  }
  if (revived.fee != null) revived.fee = String(revived.fee);
  if (revived.nonce != null) revived.nonce = String(revived.nonce);
  if (revived.transfer) {
    revived.transfer = {
      ...revived.transfer,
      addrs_to: (revived.transfer.addrs_to || []).map(toBuffer),
      amounts: (revived.transfer.amounts || []).map((amount) => String(amount)),
      message_data: revived.transfer.message_data
        ? toBuffer(revived.transfer.message_data)
        : undefined,
    };
    if (!revived.transfer.message_data) delete revived.transfer.message_data;
  }
  return revived;
}

function pushTransactionError(response) {
  if (!response || typeof response !== 'object') {
    return 'Empty pushTransaction response';
  }
  const errorCode = Number(response.error_code || response.errorCode || 0);
  const errorDescription = String(
    response.error_description || response.errorDescription || '',
  ).trim();
  const txHashHex = response.tx_hash
    ? Buffer.from(toBuffer(response.tx_hash)).toString('hex')
    : '';

  if (errorCode !== 0) {
    return errorDescription
      ? `Node rejected transaction (${errorCode}): ${errorDescription}`
      : `Node rejected transaction (${errorCode})`;
  }
  if (errorDescription && errorDescription.toLowerCase() !== 'no error') {
    return `Node rejected transaction: ${errorDescription}`;
  }
  if (!txHashHex) {
    return 'Missing tx hash in pushTransaction response';
  }
  return null;
}

async function getAddressState(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetOptimizedAddressState', {
    address: addressToBytes(request.address),
  });
  const serialized = serializeValue(response);
  if (serialized && serialized.state && serialized.state.address
    && !String(serialized.state.address).startsWith('Q')) {
    serialized.state.address = `Q${serialized.state.address}`;
  }
  return serialized;
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
    page_from: request.page_from || 1,
    page_count: request.page_count || 1,
    unused_ots_index_from: request.unused_ots_index_from || 0,
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

async function getTxnHash(request = {}) {
  const query = request.txhash || request.query || request.hash;
  const response = await callApiWithFailover(targetFor(request), 'GetObject', {
    query: toBuffer(query),
  });
  return serializeValue(response);
}

async function getTransactionsByAddress(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetTransactionsByAddress', {
    address: addressToBytes(request.address),
    item_per_page: request.item_per_page || request.items_per_page || 10,
    page_number: request.page_number || 1,
  });
  return serializeValue(response);
}

async function transferCoins(request = {}) {
  const payload = {
    addresses_to: (request.addresses_to || []).map(addressToBytes),
    amounts: (request.amounts || []).map((amount) => String(amount)),
    fee: String(request.fee || 0),
    xmss_pk: toBuffer(request.xmss_pk || request.pk),
  };
  if (request.fromAddress || request.master_addr) {
    payload.master_addr = addressToBytes(request.fromAddress || request.master_addr);
  }
  if (request.message_data) {
    payload.message_data = toBuffer(request.message_data);
  }
  const response = await callApiWithFailover(targetFor(request), 'TransferCoins', payload);
  return serializeValue(response);
}

async function pushTransaction(request = {}) {
  const signed = request.transaction_signed
    || (request.extended_transaction_unsigned && request.extended_transaction_unsigned.tx)
    || null;
  if (!signed) {
    throw new Error('transaction_signed is required');
  }

  const response = await callApiWithFailover(targetFor(request), 'PushTransaction', {
    transaction_signed: reviveSignedTransaction(signed),
  });
  const error = pushTransactionError(response);
  if (error) {
    const err = new Error(error);
    err.response = serializeValue(response);
    throw err;
  }
  const serialized = serializeValue(response);
  if (serialized.tx_hash && !String(serialized.tx_hash).startsWith('Q')) {
    // leave as hex hash
  }
  serialized.relayed = targetFor(request);
  return serialized;
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

async function qrSvg(request = {}) {
  const text = String(request.text || '').trim();
  if (!text) throw new Error('text is required');
  if (text.length > 512) throw new Error('text too long');
  const svg = await QRCode.toString(text, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#0a1720', light: '#ffffff' },
  });
  return { svg, text };
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
  getTxnHash,
  getTransactionsByAddress,
  transferCoins,
  pushTransaction,
  qrSvg,
  ledgerGetState: () => ledger.getState(),
  ledgerPublicKey: () => ledger.publicKey(),
  ledgerGetVersion: () => ledger.getVersion(),
  ledgerVerifyAddress: () => ledger.verifyAddress(),
};

module.exports = {
  handlers,
  serializeValue,
  addressToBytes,
  reviveSignedTransaction,
  pushTransactionError,
  toBuffer,
};
