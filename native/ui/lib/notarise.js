/**
 * QRL document notarisation message encoding (Meteor-compatible).
 * Payload is hex interpreted as bytes for GetMessageTxn:
 *   AFAFA + hashFnId + fileHashHex + additionalTextHex
 * SHA256 hashFnId = '2'
 * Max message size: 80 bytes → additional text ≤ 45 bytes for SHA256.
 */

export const NOTARISE_PREFIX = 'AFAFA';
export const NOTARISE_HASH_SHA256 = '2';
export const NOTARISE_SHA256_ADDITIONAL_MAX = 45;

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function utf8ToHex(text) {
  return bytesToHex(new TextEncoder().encode(String(text || '')));
}

export function buildNotarisationHex({ fileHashHex, additionalText = '', hashFunction = 'SHA256' }) {
  if (hashFunction !== 'SHA256') {
    throw new Error(`Unsupported hash function: ${hashFunction}`);
  }
  const hash = String(fileHashHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error('fileHashHex must be 64 hex characters (SHA-256)');
  }
  const extra = String(additionalText || '');
  const extraBytes = new TextEncoder().encode(extra);
  if (extraBytes.length > NOTARISE_SHA256_ADDITIONAL_MAX) {
    throw new Error(`Additional text max length is ${NOTARISE_SHA256_ADDITIONAL_MAX} bytes`);
  }
  return `${NOTARISE_PREFIX}${NOTARISE_HASH_SHA256}${hash}${utf8ToHex(extra)}`;
}

export function notarisationHexToMessageBytes(hex) {
  const clean = String(hex || '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Invalid notarisation hex');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (out.length === 0 || out.length > 80) {
    throw new Error('Notarisation message must be 1–80 bytes');
  }
  return out;
}

export async function sha256HexOfArrayBuffer(arrayBuffer) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return bytesToHex(new Uint8Array(digest));
  }
  throw new Error('Web Crypto SHA-256 unavailable');
}
