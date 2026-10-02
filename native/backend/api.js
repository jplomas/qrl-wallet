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
  if (revived.message) {
    revived.message = {
      ...revived.message,
      message_hash: revived.message.message_hash
        ? toBuffer(revived.message.message_hash)
        : undefined,
    };
  }
  if (revived.token) {
    revived.token = {
      ...revived.token,
      symbol: revived.token.symbol != null ? toBuffer(revived.token.symbol) : undefined,
      name: revived.token.name != null ? toBuffer(revived.token.name) : undefined,
      owner: revived.token.owner != null ? toBuffer(revived.token.owner) : undefined,
      decimals: revived.token.decimals != null ? String(revived.token.decimals) : undefined,
      initial_balances: (revived.token.initial_balances || []).map((entry) => ({
        address: toBuffer(entry.address),
        amount: String(entry.amount),
      })),
    };
  }
  if (revived.transfer_token) {
    revived.transfer_token = {
      ...revived.transfer_token,
      token_txhash: revived.transfer_token.token_txhash
        ? toBuffer(revived.transfer_token.token_txhash)
        : undefined,
      addrs_to: (revived.transfer_token.addrs_to || []).map(toBuffer),
      amounts: (revived.transfer_token.amounts || []).map((amount) => String(amount)),
    };
  }
  if (revived.multi_sig_create) {
    revived.multi_sig_create = {
      ...revived.multi_sig_create,
      threshold: revived.multi_sig_create.threshold != null
        ? String(revived.multi_sig_create.threshold)
        : undefined,
      signatories: (revived.multi_sig_create.signatories || []).map(toBuffer),
      weights: (revived.multi_sig_create.weights || []).map((weight) => String(weight)),
    };
  }
  if (revived.multi_sig_spend) {
    revived.multi_sig_spend = {
      ...revived.multi_sig_spend,
      multi_sig_address: revived.multi_sig_spend.multi_sig_address
        ? toBuffer(revived.multi_sig_spend.multi_sig_address)
        : undefined,
      expiry_block_number: revived.multi_sig_spend.expiry_block_number != null
        ? String(revived.multi_sig_spend.expiry_block_number)
        : undefined,
      addrs_to: (revived.multi_sig_spend.addrs_to || []).map(toBuffer),
      amounts: (revived.multi_sig_spend.amounts || []).map((amount) => String(amount)),
    };
  }
  if (revived.multi_sig_vote) {
    revived.multi_sig_vote = {
      ...revived.multi_sig_vote,
      shared_key: revived.multi_sig_vote.shared_key
        ? toBuffer(revived.multi_sig_vote.shared_key)
        : undefined,
      unvote: Boolean(revived.multi_sig_vote.unvote),
    };
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

async function createMessageTxn(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetMessageTxn', {
    message: toBuffer(request.message),
    fee: String(request.fee || 0),
    xmss_pk: toBuffer(request.xmss_pk || request.pk),
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

function utf8Buffer(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) {
    return toBuffer(value);
  }
  return Buffer.from(String(value), 'utf8');
}

async function getTokensByAddress(request = {}) {
  const full = await callApiWithFailover(targetFor(request), 'GetAddressState', {
    address: addressToBytes(request.address),
  });
  const tokensMap = (full && full.state && full.state.tokens) || {};
  const tokens = [];
  for (const [tokenHash, balance] of Object.entries(tokensMap)) {
    const entry = {
      hash: tokenHash,
      balance: String(balance),
    };
    try {
      const obj = await callApiWithFailover(targetFor(request), 'GetObject', {
        query: Buffer.from(tokenHash, 'hex'),
      });
      const tx = obj && obj.transaction && obj.transaction.tx;
      const tokenDetails = tx && tx.token;
      if (!tokenDetails) {
        entry.unknown = true;
        tokens.push(entry);
        continue;
      }
      const decimals = Number(tokenDetails.decimals || 0);
      const symbolBuf = toBuffer(tokenDetails.symbol);
      const nameBuf = toBuffer(tokenDetails.name);
      const symbolHex = symbolBuf.toString('hex');
      const isNft = symbolHex.slice(0, 8).toLowerCase() === '00ff00ff';
      entry.decimals = decimals;
      entry.balance_display = Number(balance) / (10 ** decimals);
      entry.is_nft = isNft;
      entry.symbol = isNft ? symbolHex : symbolBuf.toString('utf8');
      entry.name = isNft ? nameBuf.toString('hex') : nameBuf.toString('utf8');
      tokens.push(entry);
    } catch (error) {
      entry.error = error.message || String(error);
      tokens.push(entry);
    }
  }
  return serializeValue({
    address: request.address,
    tokens,
  });
}

async function createTokenTxn(request = {}) {
  const payload = {
    symbol: utf8Buffer(request.symbol),
    name: utf8Buffer(request.name),
    owner: addressToBytes(request.owner),
    decimals: String(request.decimals != null ? request.decimals : 0),
    initial_balances: (request.initial_balances || request.initialBalances || []).map((entry) => ({
      address: addressToBytes(entry.address),
      amount: String(entry.amount),
    })),
    fee: String(request.fee || 0),
    xmss_pk: toBuffer(request.xmss_pk || request.pk || request.xmssPk),
  };
  const response = await callApiWithFailover(targetFor(request), 'GetTokenTxn', payload);
  return serializeValue(response);
}

async function transferTokenTxn(request = {}) {
  const payload = {
    addresses_to: (request.addresses_to || []).map(addressToBytes),
    amounts: (request.amounts || []).map((amount) => String(amount)),
    token_txhash: toBuffer(request.token_txhash || request.tokenHash),
    fee: String(request.fee || 0),
    xmss_pk: toBuffer(request.xmss_pk || request.pk || request.xmssPk),
  };
  const response = await callApiWithFailover(targetFor(request), 'GetTransferTokenTxn', payload);
  return serializeValue(response);
}

async function getMultiSigAddressesByAddress(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetMultiSigAddressesByAddress', {
    address: addressToBytes(request.address),
    item_per_page: request.item_per_page || request.items_per_page || 10,
    page_number: request.page_number || 1,
  });
  return serializeValue(response);
}

async function getMultiSigSpendTxsByAddress(request = {}) {
  const response = await callApiWithFailover(targetFor(request), 'GetMultiSigSpendTxsByAddress', {
    address: addressToBytes(request.address),
    item_per_page: request.item_per_page || request.items_per_page || 10,
    page_number: request.page_number || 1,
    filter_type: request.filter_type || 0,
  });
  return serializeValue(response);
}

async function createMultiSigTxn(request = {}) {
  const payload = {
    signatories: (request.signatories || []).map(addressToBytes),
    weights: (request.weights || []).map((weight) => String(weight)),
    threshold: String(request.threshold || 0),
    fee: String(request.fee || 0),
    xmss_pk: toBuffer(request.xmss_pk || request.pk || request.xmssPk),
  };
  if (request.fromAddress || request.master_addr) {
    payload.master_addr = addressToBytes(request.fromAddress || request.master_addr);
  }
  const response = await callApiWithFailover(targetFor(request), 'GetMultiSigCreateTxn', payload);
  return serializeValue(response);
}

async function spendMultiSigTxn(request = {}) {
  const payload = {
    multi_sig_address: addressToBytes(request.multi_sig_address),
    addrs_to: (request.addrs_to || request.addresses_to || []).map(addressToBytes),
    amounts: (request.amounts || []).map((amount) => String(amount)),
    expiry_block_number: String(request.expiry_block_number || 0),
    fee: String(request.fee || 0),
    xmss_pk: toBuffer(request.xmss_pk || request.pk || request.xmssPk),
  };
  const response = await callApiWithFailover(targetFor(request), 'GetMultiSigSpendTxn', payload);
  return serializeValue(response);
}

async function voteMultiSigTxn(request = {}) {
  const payload = {
    shared_key: toBuffer(request.shared_key),
    unvote: Boolean(request.unvote),
    fee: String(request.fee || 0),
    xmss_pk: toBuffer(request.xmss_pk || request.pk || request.xmssPk),
  };
  const response = await callApiWithFailover(targetFor(request), 'GetMultiSigVoteTxn', payload);
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

async function githubLookup(request = {}) {
  const username = String(request.username || '').trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(username)) {
    throw new Error('Invalid Github username');
  }
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'QRLWallet-Native',
    },
  });
  if (response.status === 404) {
    throw new Error(`Github user ${username} not found`);
  }
  if (!response.ok) {
    throw new Error(`Github lookup failed (${response.status})`);
  }
  const data = await response.json();
  return {
    username: data.login || username,
    id: data.id,
    html_url: data.html_url,
    name: data.name || null,
  };
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
  getTokensByAddress,
  createTokenTxn,
  transferTokenTxn,
  getMultiSigAddressesByAddress,
  getMultiSigSpendTxsByAddress,
  createMultiSigTxn,
  spendMultiSigTxn,
  voteMultiSigTxn,
  transferCoins,
  pushTransaction,
  createMessageTxn,
  qrSvg,
  githubLookup,
  ledgerGetState: (request = {}) => ledger.getState(request.timeout_ms),
  ledgerPublicKey: (request = {}) => ledger.publicKey(request.timeout_ms),
  ledgerGetVersion: (request = {}) => ledger.getVersion(request.timeout_ms),
  ledgerVerifyAddress: (request = {}) => ledger.verifyAddress(request.timeout_ms),
  ledgerSetIdx: (request = {}) => ledger.setIdx(request.ots_index ?? request.otsKey, request.timeout_ms),
  ledgerCreateTx: (request = {}) => ledger.createTx({
    sourceAddr: request.source_addr || request.sourceAddr || addressToBytes(request.address),
    fee: request.fee,
    addressesTo: request.addresses_to || request.addressesTo,
    amounts: request.amounts,
  }, request.timeout_ms),
  ledgerRetrieveSignature: (request = {}) => {
    const timeoutMs = request.timeout_ms;
    const txn = request.txn || (() => {
      const { timeout_ms: _ignored, ...rest } = request;
      return rest;
    })();
    return ledger.retrieveSignature(txn, timeoutMs);
  },
  ledgerCreateMessageTx: (request = {}) => ledger.createMessageTx({
    sourceAddr: request.source_addr || request.sourceAddr || addressToBytes(request.address),
    fee: request.fee,
    message: request.message,
  }, request.timeout_ms),
  ledgerSignTransfer: (request = {}) => ledger.signTransfer({
    sourceAddr: request.source_addr || request.sourceAddr || addressToBytes(request.address),
    fee: request.fee,
    addressesTo: (request.addresses_to || request.addressesTo || []).map((addr) => (
      typeof addr === 'string' && addr.startsWith('Q') ? addressToBytes(addr) : addr
    )),
    amounts: request.amounts,
    otsIndex: request.ots_index ?? request.otsKey ?? request.otsIndex,
  }, request.timeout_ms || 120000),
};

module.exports = {
  handlers,
  serializeValue,
  addressToBytes,
  reviveSignedTransaction,
  pushTransactionError,
  toBuffer,
};
