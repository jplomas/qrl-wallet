/* global QRLLIB */

import {
  binaryToBytes,
  bytesToHex,
  concatenateTypedArrays,
  hexToBytes,
  toBigendianUint64BytesUnsigned,
  toUint8Vector,
} from './bytes.js';

function coerceAddrBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    const hex = value.startsWith('Q') ? value.slice(1) : value;
    return hexToBytes(hex);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('Unsupported address bytes');
}

/**
 * Sign a TransferCoins response using a live XMSS object.
 * Matches Meteor `confirmTransaction` hashing for Quanta transfers (no message).
 */
export function signTransferTransaction(xmss, transferResponse, otsIndex) {
  if (!xmss) throw new Error('XMSS object required');
  if (!transferResponse || !transferResponse.extended_transaction_unsigned) {
    throw new Error('Missing unsigned transfer response');
  }

  const unsigned = structuredClone
    ? structuredClone(transferResponse)
    : JSON.parse(JSON.stringify(transferResponse));
  const tx = unsigned.extended_transaction_unsigned.tx;
  if (!tx || !tx.transfer) {
    throw new Error('Transfer payload missing from node response');
  }

  const ots = Number(otsIndex);
  if (!Number.isInteger(ots) || ots < 0) {
    throw new Error('OTS index must be a non-negative integer');
  }
  xmss.setIndex(ots);

  let concatenated = concatenateTypedArrays(
    Uint8Array,
    toBigendianUint64BytesUnsigned(tx.fee),
  );

  const addrsTo = tx.transfer.addrs_to || [];
  const amounts = tx.transfer.amounts || [];
  if (addrsTo.length !== amounts.length || addrsTo.length === 0) {
    throw new Error('Transfer outputs are invalid');
  }

  for (let i = 0; i < addrsTo.length; i += 1) {
    concatenated = concatenateTypedArrays(
      Uint8Array,
      concatenated,
      coerceAddrBytes(addrsTo[i]),
      toBigendianUint64BytesUnsigned(amounts[i]),
    );
  }

  const hashableBytes = toUint8Vector(concatenated);
  const shaSum = QRLLIB.sha2_256(hashableBytes);
  const signatureBytes = binaryToBytes(xmss.sign(shaSum));
  const pkHex = xmss.getPK();
  const pkBytes = hexToBytes(pkHex);

  tx.signature = bytesToHex(signatureBytes);
  tx.public_key = pkHex;

  const txnHashConcat = concatenateTypedArrays(
    Uint8Array,
    binaryToBytes(shaSum),
    signatureBytes,
    pkBytes,
  );
  const txnHash = QRLLIB.bin2hstr(QRLLIB.sha2_256(toUint8Vector(txnHashConcat)));

  return {
    unsigned,
    signedTx: tx,
    signatureHex: bytesToHex(signatureBytes),
    txnHash,
    otsIndex: ots,
  };
}

/** Attach a Ledger-produced signature to an unsigned transfer and compute tx hash. */
export function finalizeLedgerTransfer(transferResponse, signatureHex, pkHex) {
  if (!transferResponse || !transferResponse.extended_transaction_unsigned) {
    throw new Error('Missing unsigned transfer response');
  }
  const unsigned = structuredClone
    ? structuredClone(transferResponse)
    : JSON.parse(JSON.stringify(transferResponse));
  const tx = unsigned.extended_transaction_unsigned.tx;
  if (!tx || !tx.transfer) {
    throw new Error('Transfer payload missing from node response');
  }

  let concatenated = concatenateTypedArrays(
    Uint8Array,
    toBigendianUint64BytesUnsigned(tx.fee),
  );
  const addrsTo = tx.transfer.addrs_to || [];
  const amounts = tx.transfer.amounts || [];
  for (let i = 0; i < addrsTo.length; i += 1) {
    concatenated = concatenateTypedArrays(
      Uint8Array,
      concatenated,
      coerceAddrBytes(addrsTo[i]),
      toBigendianUint64BytesUnsigned(amounts[i]),
    );
  }

  const shaSum = QRLLIB.sha2_256(toUint8Vector(concatenated));
  const sigHex = String(signatureHex || '').replace(/^0x/i, '');
  const signatureBytes = hexToBytes(sigHex);
  const pk = String(pkHex || '');
  tx.signature = sigHex;
  tx.public_key = pk;

  const txnHash = QRLLIB.bin2hstr(QRLLIB.sha2_256(toUint8Vector(concatenateTypedArrays(
    Uint8Array,
    binaryToBytes(shaSum),
    signatureBytes,
    hexToBytes(pk),
  ))));

  return {
    unsigned,
    signedTx: tx,
    signatureHex: sigHex,
    txnHash,
  };
}

export function ensureXmssFromWallet(wallet) {
  if (!wallet) throw new Error('Wallet required');
  if (wallet.type === 'ledger') {
    throw new Error('Ledger wallets cannot create a local XMSS object');
  }
  if (wallet.xmss) return wallet.xmss;
  if (wallet.hexseed) {
    wallet.xmss = QRLLIB.Xmss.fromHexSeed(wallet.hexseed);
    return wallet.xmss;
  }
  if (wallet.mnemonic) {
    wallet.xmss = QRLLIB.Xmss.fromMnemonic(wallet.mnemonic);
    return wallet.xmss;
  }
  throw new Error('Wallet has no XMSS seed material');
}
