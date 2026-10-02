/* global QRLLIB */

import {
  binaryToBytes,
  bytesToHex,
  concatenateTypedArrays,
  hexToBytes,
  toBigendianUint64BytesUnsigned,
  toUint8Vector,
} from './bytes.js';

export function signMessageTransaction(xmss, messageResponse, otsIndex) {
  if (!xmss) throw new Error('XMSS object required');
  if (!messageResponse || !messageResponse.extended_transaction_unsigned) {
    throw new Error('Missing unsigned message response');
  }

  const unsigned = structuredClone
    ? structuredClone(messageResponse)
    : JSON.parse(JSON.stringify(messageResponse));
  const tx = unsigned.extended_transaction_unsigned.tx;
  if (!tx || !tx.message || !tx.message.message_hash) {
    throw new Error('Message payload missing from node response');
  }

  const ots = Number(otsIndex);
  if (!Number.isInteger(ots) || ots < 0) {
    throw new Error('OTS index must be a non-negative integer');
  }
  xmss.setIndex(ots);

  const messageHash = typeof tx.message.message_hash === 'string'
    ? hexToBytes(tx.message.message_hash)
    : Uint8Array.from(tx.message.message_hash);

  const concatenated = concatenateTypedArrays(
    Uint8Array,
    toBigendianUint64BytesUnsigned(tx.fee),
    messageHash,
  );
  const shaSum = QRLLIB.sha2_256(toUint8Vector(concatenated));
  const signatureBytes = binaryToBytes(xmss.sign(shaSum));
  const pkHex = xmss.getPK();

  tx.signature = bytesToHex(signatureBytes);
  tx.public_key = pkHex;

  const txnHashConcat = concatenateTypedArrays(
    Uint8Array,
    binaryToBytes(shaSum),
    signatureBytes,
    hexToBytes(pkHex),
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
