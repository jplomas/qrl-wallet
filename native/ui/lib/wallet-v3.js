import { scrypt as scryptFn } from './vendor/scrypt-js-esm.js';

const DEFAULT_SCRYPT_PARAMS = {
  N: 1 << 17,
  r: 8,
  p: 1,
  dkLen: 32,
  saltLen: 32,
};

const DEFAULT_IV_LEN = 12;
const TAG_LEN = 16;

export const WALLET_PASSPHRASE_REQUIRED = 'WALLET_PASSPHRASE_REQUIRED';
export const WALLET_PASSPHRASE_INCORRECT = 'WALLET_PASSPHRASE_INCORRECT';

function walletError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function encodeUtf8(text) {
  return new TextEncoder().encode(text);
}

function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i].toString(16);
    hex += value.length === 1 ? `0${value}` : value;
  }
  return hex;
}

function buildAad(meta) {
  return encodeUtf8(JSON.stringify({
    version: meta.version,
    kdf: meta.kdf,
    cipher: {
      name: meta.cipher.name,
      iv: meta.cipher.iv,
    },
  }));
}

async function encryptAead(plainBytes, keyBytes, iv, aad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const algorithm = { name: 'AES-GCM', iv, tagLength: TAG_LEN * 8, additionalData: aad };
  const cipherBuffer = await crypto.subtle.encrypt(algorithm, key, plainBytes);
  const cipherBytes = new Uint8Array(cipherBuffer);
  return {
    encrypted: cipherBytes.slice(0, cipherBytes.length - TAG_LEN),
    authTag: cipherBytes.slice(cipherBytes.length - TAG_LEN),
  };
}

async function decryptAead(encryptedBytes, keyBytes, iv, authTag, aad) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const combined = new Uint8Array(encryptedBytes.length + authTag.length);
  combined.set(encryptedBytes);
  combined.set(authTag, encryptedBytes.length);
  const algorithm = { name: 'AES-GCM', iv, tagLength: TAG_LEN * 8, additionalData: aad };
  const plainBuffer = await crypto.subtle.decrypt(algorithm, key, combined);
  return new Uint8Array(plainBuffer);
}

async function deriveKeyScrypt(password, salt, params, progressCallback) {
  const passwordBytes = typeof password === 'string' ? encodeUtf8(password) : new Uint8Array(password);
  return scryptFn(passwordBytes, salt, params.N, params.r, params.p, params.dkLen, progressCallback);
}

export function normalizeWalletRecord(walletRecord) {
  if (!walletRecord || typeof walletRecord !== 'object') {
    throw new Error('Invalid wallet record');
  }
  const normalized = {
    address: walletRecord.address,
    pk: walletRecord.pk,
    hexseed: walletRecord.hexseed,
    mnemonic: walletRecord.mnemonic,
    height: walletRecord.height,
    hashFunction: walletRecord.hashFunction || 'SHAKE_128',
    signatureType: walletRecord.signatureType || 0,
    index: Number.isInteger(walletRecord.index) ? walletRecord.index : 0,
  };
  if (!/^Q[0-9a-fA-F]{78}$/.test(normalized.address)
    || !/^[0-9a-fA-F]{134}$/.test(normalized.pk)
    || !/^[0-9a-fA-F]{102}$/.test(normalized.hexseed)
    || String(normalized.mnemonic || '').trim().split(/\s+/).length !== 34) {
    throw new Error('Wallet content is invalid or passphrase is incorrect');
  }
  return normalized;
}

export async function buildEncryptedEnvelope(walletData, password, progressCallback) {
  const params = { ...DEFAULT_SCRYPT_PARAMS };
  const salt = randomBytes(params.saltLen);
  const iv = randomBytes(DEFAULT_IV_LEN);
  const key = await deriveKeyScrypt(password, salt, params, progressCallback);
  const meta = {
    version: 3,
    kdf: {
      name: 'scrypt',
      params: {
        N: params.N,
        r: params.r,
        p: params.p,
        dkLen: params.dkLen,
        salt: bytesToHex(salt),
      },
    },
    cipher: {
      name: 'aes-256-gcm',
      iv: bytesToHex(iv),
    },
  };
  const { encrypted, authTag } = await encryptAead(
    encodeUtf8(JSON.stringify(walletData)),
    key,
    iv,
    buildAad(meta),
  );
  meta.cipher.authTag = bytesToHex(authTag);
  return {
    version: 3,
    encrypted: true,
    kdf: meta.kdf,
    cipher: meta.cipher,
    data: bytesToHex(encrypted),
  };
}

export function buildUnencryptedEnvelope(walletData) {
  return {
    version: 3,
    encrypted: false,
    data: walletData,
  };
}

export async function decryptV3Envelope(envelope, password, progressCallback) {
  if (!envelope || envelope.version !== 3 || typeof envelope.encrypted !== 'boolean') {
    throw new Error('Invalid wallet envelope');
  }
  if (!envelope.encrypted) {
    return typeof envelope.data === 'string' ? JSON.parse(envelope.data) : envelope.data;
  }
  if (!password) {
    throw walletError('Missing passphrase for encrypted wallet', WALLET_PASSPHRASE_REQUIRED);
  }
  if (!envelope.kdf || !envelope.kdf.params || !envelope.cipher) {
    throw new Error('Invalid encrypted wallet envelope');
  }
  if (envelope.kdf.name !== 'scrypt') {
    throw new Error(`Unsupported KDF: ${envelope.kdf.name}`);
  }
  const params = { ...DEFAULT_SCRYPT_PARAMS, ...envelope.kdf.params };
  const salt = hexToBytes(params.salt);
  delete params.salt;
  const iv = hexToBytes(envelope.cipher.iv);
  const authTag = hexToBytes(envelope.cipher.authTag);
  const key = await deriveKeyScrypt(password, salt, params, progressCallback);
  let plainBytes;
  try {
    plainBytes = await decryptAead(
      hexToBytes(envelope.data),
      key,
      iv,
      authTag,
      buildAad({
        version: envelope.version,
        kdf: envelope.kdf,
        cipher: { name: envelope.cipher.name, iv: envelope.cipher.iv },
      }),
    );
  } catch (_) {
    throw walletError('Wallet passphrase is incorrect', WALLET_PASSPHRASE_INCORRECT);
  }
  return JSON.parse(decodeUtf8(plainBytes));
}

export function downloadWalletFile(envelope, filename = 'wallet.json') {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
