/* global QRLLIB */

import {
  binaryToBytes,
  bytesToHex,
  concatenateTypedArrays,
  hexToBytes,
  toBigendianUint64BytesUnsigned,
  toUint8Vector,
} from './bytes.js';

function coerceBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) return hexToBytes(value);
    return new TextEncoder().encode(value);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('Unsupported byte value');
}

export function signTokenCreateTransaction(xmss, tokenResponse, otsIndex) {
  if (!xmss) throw new Error('XMSS object required');
  const unsigned = structuredClone
    ? structuredClone(tokenResponse)
    : JSON.parse(JSON.stringify(tokenResponse));
  const tx = unsigned.extended_transaction_unsigned.tx;
  if (!tx || !tx.token) throw new Error('Token payload missing');

  const ots = Number(otsIndex);
  if (!Number.isInteger(ots) || ots < 0) throw new Error('Invalid OTS index');
  xmss.setIndex(ots);

  let hashable = concatenateTypedArrays(
    Uint8Array,
    toBigendianUint64BytesUnsigned(tx.fee),
    coerceBytes(tx.token.symbol),
    coerceBytes(tx.token.name),
    coerceBytes(tx.token.owner),
    toBigendianUint64BytesUnsigned(tx.token.decimals),
  );

  for (const holder of tx.token.initial_balances || []) {
    hashable = concatenateTypedArrays(
      Uint8Array,
      hashable,
      coerceBytes(holder.address),
      toBigendianUint64BytesUnsigned(holder.amount),
    );
  }

  const shaSum = QRLLIB.sha2_256(toUint8Vector(hashable));
  const signatureBytes = binaryToBytes(xmss.sign(shaSum));
  const pkHex = xmss.getPK();
  tx.signature = bytesToHex(signatureBytes);
  tx.public_key = pkHex;

  const txnHash = QRLLIB.bin2hstr(QRLLIB.sha2_256(toUint8Vector(concatenateTypedArrays(
    Uint8Array,
    binaryToBytes(shaSum),
    signatureBytes,
    hexToBytes(pkHex),
  ))));

  return { signedTx: tx, txnHash, signatureHex: bytesToHex(signatureBytes), otsIndex: ots };
}

export function signTokenTransferTransaction(xmss, tokenTransferResponse, otsIndex) {
  if (!xmss) throw new Error('XMSS object required');
  const unsigned = structuredClone
    ? structuredClone(tokenTransferResponse)
    : JSON.parse(JSON.stringify(tokenTransferResponse));
  const tx = unsigned.extended_transaction_unsigned.tx;
  if (!tx || !tx.transfer_token) throw new Error('Token transfer payload missing');

  const ots = Number(otsIndex);
  if (!Number.isInteger(ots) || ots < 0) throw new Error('Invalid OTS index');
  xmss.setIndex(ots);

  let hashable = concatenateTypedArrays(
    Uint8Array,
    toBigendianUint64BytesUnsigned(tx.fee),
    coerceBytes(tx.transfer_token.token_txhash),
  );
  const addrs = tx.transfer_token.addrs_to || [];
  const amounts = tx.transfer_token.amounts || [];
  for (let i = 0; i < addrs.length; i += 1) {
    hashable = concatenateTypedArrays(
      Uint8Array,
      hashable,
      coerceBytes(addrs[i]),
      toBigendianUint64BytesUnsigned(amounts[i]),
    );
  }

  const shaSum = QRLLIB.sha2_256(toUint8Vector(hashable));
  const signatureBytes = binaryToBytes(xmss.sign(shaSum));
  const pkHex = xmss.getPK();
  tx.signature = bytesToHex(signatureBytes);
  tx.public_key = pkHex;
  const txnHash = QRLLIB.bin2hstr(QRLLIB.sha2_256(toUint8Vector(concatenateTypedArrays(
    Uint8Array,
    binaryToBytes(shaSum),
    signatureBytes,
    hexToBytes(pkHex),
  ))));
  return { signedTx: tx, txnHash, signatureHex: bytesToHex(signatureBytes), otsIndex: ots };
}
