const TransportNodeHid = require('@ledgerhq/hw-transport-node-hid').default;
const Qrl = require('@theqrl/hw-app-qrl/lib/Qrl').default;

const DEFAULT_TIMEOUT_MS = 12000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms — is the Ledger unlocked with the QRL app open?`));
      }, ms);
    }),
  ]);
}

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

function u64Buffer(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) {
    const buf = toBuffer(value);
    if (buf.length !== 8) throw new Error('uint64 buffer must be 8 bytes');
    return buf;
  }
  let n = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error('Invalid uint64 value');
  }
  const byteArray = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < byteArray.length; index += 1) {
    const byte = n & 0xff;
    byteArray[index] = byte;
    n = (n - byte) / 256;
  }
  byteArray.reverse();
  return Buffer.from(byteArray);
}

function serializeLedgerValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) {
    return value.map(serializeLedgerValue);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = serializeLedgerValue(entry);
    }
    return out;
  }
  return value;
}

async function withLedger(fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const transport = await withTimeout(TransportNodeHid.create(), timeoutMs, 'Ledger USB connect');
  try {
    const qrl = new Qrl(transport);
    const result = await withTimeout(fn(qrl), timeoutMs, 'Ledger command');
    return serializeLedgerValue(result);
  } finally {
    await transport.close().catch(() => {});
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  u64Buffer,
  serializeLedgerValue,
  async getState(timeoutMs) {
    return withLedger((qrl) => qrl.get_state(), timeoutMs);
  },
  async publicKey(timeoutMs) {
    return withLedger((qrl) => qrl.publickey(), timeoutMs);
  },
  async getVersion(timeoutMs) {
    return withLedger((qrl) => qrl.get_version(), timeoutMs);
  },
  async verifyAddress(timeoutMs) {
    return withLedger((qrl) => qrl.viewAddress(), timeoutMs);
  },
  async setIdx(otsKey, timeoutMs) {
    return withLedger((qrl) => qrl.setIdx(Number(otsKey)), timeoutMs);
  },
  async createTx({ sourceAddr, fee, addressesTo, amounts }, timeoutMs) {
    const source = toBuffer(sourceAddr);
    const feeBuf = u64Buffer(fee);
    const destAddrs = (addressesTo || []).map((addr) => toBuffer(addr));
    const destAmounts = (amounts || []).map((amount) => u64Buffer(amount));
    return withLedger(
      (qrl) => qrl.createTx(source, feeBuf, destAddrs, destAmounts),
      timeoutMs,
    );
  },
  async retrieveSignature(txn, timeoutMs) {
    return withLedger((qrl) => qrl.retrieveSignature(txn), timeoutMs);
  },
  async createMessageTx({ sourceAddr, fee, message }, timeoutMs) {
    return withLedger(
      (qrl) => qrl.createMessageTx(toBuffer(sourceAddr), u64Buffer(fee), toBuffer(message)),
      timeoutMs,
    );
  },
  /**
   * setIdx + createTx + retrieveSignature in one USB session (avoids
   * hex-roundtrip of the intermediate txn between API calls).
   */
  async signTransfer({
    sourceAddr, fee, addressesTo, amounts, otsIndex,
  }, timeoutMs = 120000) {
    return withLedger(async (qrl) => {
      if (otsIndex != null && otsIndex !== '') {
        await qrl.setIdx(Number(otsIndex));
      }
      const source = toBuffer(sourceAddr);
      const feeBuf = u64Buffer(fee);
      const destAddrs = (addressesTo || []).map((addr) => toBuffer(addr));
      const destAmounts = (amounts || []).map((amount) => u64Buffer(amount));
      const txn = await qrl.createTx(source, feeBuf, destAddrs, destAmounts);
      return qrl.retrieveSignature(txn);
    }, timeoutMs);
  },
};
