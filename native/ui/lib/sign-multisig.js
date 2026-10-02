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

function cloneTxResponse(response) {
  return structuredClone
    ? structuredClone(response)
    : JSON.parse(JSON.stringify(response));
}

function signShaSum(xmss, shaSum, pkHex) {
  const signatureBytes = binaryToBytes(xmss.sign(shaSum));
  const txnHash = QRLLIB.bin2hstr(QRLLIB.sha2_256(toUint8Vector(concatenateTypedArrays(
    Uint8Array,
    binaryToBytes(shaSum),
    signatureBytes,
    hexToBytes(pkHex),
  ))));
  return { signatureBytes, txnHash, signatureHex: bytesToHex(signatureBytes) };
}

export function signMultiSigCreateTransaction(xmss, response, otsIndex) {
  if (!xmss) throw new Error('XMSS object required');
  const unsigned = cloneTxResponse(response);
  const tx = unsigned.extended_transaction_unsigned.tx;
  if (!tx || !tx.multi_sig_create) throw new Error('Multi-sig create payload missing');

  const ots = Number(otsIndex);
  if (!Number.isInteger(ots) || ots < 0) throw new Error('Invalid OTS index');
  xmss.setIndex(ots);

  let hashable = concatenateTypedArrays(
    Uint8Array,
    toBigendianUint64BytesUnsigned(tx.fee),
    toBigendianUint64BytesUnsigned(tx.multi_sig_create.threshold),
  );
  const signatories = tx.multi_sig_create.signatories || [];
  const weights = tx.multi_sig_create.weights || [];
  for (let i = 0; i < signatories.length; i += 1) {
    hashable = concatenateTypedArrays(
      Uint8Array,
      hashable,
      coerceAddrBytes(signatories[i]),
      toBigendianUint64BytesUnsigned(weights[i]),
    );
  }

  const shaSum = QRLLIB.sha2_256(toUint8Vector(hashable));
  const pkHex = xmss.getPK();
  const signed = signShaSum(xmss, shaSum, pkHex);
  tx.signature = signed.signatureHex;
  tx.public_key = pkHex;
  return { signedTx: tx, txnHash: signed.txnHash, signatureHex: signed.signatureHex, otsIndex: ots };
}

export function signMultiSigSpendTransaction(xmss, response, otsIndex) {
  if (!xmss) throw new Error('XMSS object required');
  const unsigned = cloneTxResponse(response);
  const tx = unsigned.extended_transaction_unsigned.tx;
  if (!tx || !tx.multi_sig_spend) throw new Error('Multi-sig spend payload missing');

  const ots = Number(otsIndex);
  if (!Number.isInteger(ots) || ots < 0) throw new Error('Invalid OTS index');
  xmss.setIndex(ots);

  let hashable = concatenateTypedArrays(
    Uint8Array,
    toBigendianUint64BytesUnsigned(tx.fee),
    coerceAddrBytes(tx.multi_sig_spend.multi_sig_address),
    toBigendianUint64BytesUnsigned(tx.multi_sig_spend.expiry_block_number),
  );
  const addrs = tx.multi_sig_spend.addrs_to || [];
  const amounts = tx.multi_sig_spend.amounts || [];
  for (let i = 0; i < addrs.length; i += 1) {
    hashable = concatenateTypedArrays(
      Uint8Array,
      hashable,
      coerceAddrBytes(addrs[i]),
      toBigendianUint64BytesUnsigned(amounts[i]),
    );
  }

  const shaSum = QRLLIB.sha2_256(toUint8Vector(hashable));
  const pkHex = xmss.getPK();
  const signed = signShaSum(xmss, shaSum, pkHex);
  tx.signature = signed.signatureHex;
  tx.public_key = pkHex;
  return { signedTx: tx, txnHash: signed.txnHash, signatureHex: signed.signatureHex, otsIndex: ots };
}

export function signMultiSigVoteTransaction(xmss, response, otsIndex) {
  if (!xmss) throw new Error('XMSS object required');
  const unsigned = cloneTxResponse(response);
  const tx = unsigned.extended_transaction_unsigned.tx;
  if (!tx || !tx.multi_sig_vote) throw new Error('Multi-sig vote payload missing');

  const ots = Number(otsIndex);
  if (!Number.isInteger(ots) || ots < 0) throw new Error('Invalid OTS index');
  xmss.setIndex(ots);

  const unvote = new Uint8Array(1);
  unvote[0] = tx.multi_sig_vote.unvote ? 1 : 0;
  const hashable = concatenateTypedArrays(
    Uint8Array,
    toBigendianUint64BytesUnsigned(tx.fee),
    coerceAddrBytes(tx.multi_sig_vote.shared_key),
    unvote,
  );

  const shaSum = QRLLIB.sha2_256(toUint8Vector(hashable));
  const pkHex = xmss.getPK();
  const signed = signShaSum(xmss, shaSum, pkHex);
  tx.signature = signed.signatureHex;
  tx.public_key = pkHex;
  return { signedTx: tx, txnHash: signed.txnHash, signatureHex: signed.signatureHex, otsIndex: ots };
}
