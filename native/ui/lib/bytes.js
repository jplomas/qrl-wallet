/* global QRLLIB */

export function hexToBytes(hex) {
  const clean = String(hex || '').replace(/^0x/i, '');
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => (`00${(byte & 0xff).toString(16)}`).slice(-2)).join('');
}

export function binaryToBytes(convertMe) {
  const thisBytes = new Uint8Array(convertMe.size());
  for (let i = 0; i < convertMe.size(); i += 1) {
    thisBytes[i] = convertMe.get(i);
  }
  return thisBytes;
}

export function toUint8Vector(arr) {
  const vec = new QRLLIB.Uint8Vector();
  for (let i = 0; i < arr.length; i += 1) {
    vec.push_back(arr[i]);
  }
  return vec;
}

export function concatenateTypedArrays(resultConstructor, ...arrays) {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.length;
  const result = new resultConstructor(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export function toBigendianUint64BytesUnsigned(input) {
  let value = input;
  if (!Number.isInteger(value)) {
    value = parseInt(value, 10);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Invalid uint64 value');
  }
  const byteArray = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < byteArray.length; index += 1) {
    const byte = value & 0xff;
    byteArray[index] = byte;
    value = (value - byte) / 256;
  }
  byteArray.reverse();
  return Uint8Array.from(byteArray);
}

export function addressToBytes(address) {
  if (typeof address === 'string' && address.startsWith('Q')) {
    return hexToBytes(address.slice(1));
  }
  if (typeof address === 'string') return hexToBytes(address);
  if (address instanceof Uint8Array) return address;
  throw new Error('Invalid address');
}
