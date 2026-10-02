/**
 * Meteor-compatible Keybase / Github identity message encodings.
 * Both are GetMessageTxn payloads (≤80 bytes).
 */

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Invalid hex');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Keybase: 0F0F0002 + AA|AF + " {id} " utf8 + 66-char sighash hex bytes
 * AA = add, AF = remove
 */
export function buildKeybaseMessageBytes({ keybaseId, sigHash, add }) {
  const id = String(keybaseId || '').trim();
  if (!id) throw new Error('Keybase username is required');
  const hash = String(sigHash || '').trim();
  if (!/^[0-9a-fA-F]{66}$/.test(hash)) {
    throw new Error('Keybase sighash must be 66 hex characters');
  }
  const prefix = hexToBytes(`0F0F0002${add ? 'AA' : 'AF'}`);
  const idBytes = new TextEncoder().encode(` ${id} `);
  const sighashBytes = hexToBytes(hash);
  const message = concatBytes(prefix, idBytes, sighashBytes);
  if (message.length > 80) {
    throw new Error('Keybase message exceeds 80 bytes (shorten username)');
  }
  return message;
}

/**
 * Github: 0F0F0003 + 00|01 + 00000000 + 66-char sighash + 4-byte BE github user id
 * 00 = add, 01 = remove
 */
export function buildGithubMessageBytes({ githubUserId, sigHash, add }) {
  const userId = Number(githubUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Github user id must be a positive integer');
  }
  const hash = String(sigHash || '').trim();
  if (!/^[0-9a-fA-F]{66}$/.test(hash)) {
    throw new Error('Github sighash must be 66 hex characters');
  }
  const prefix = hexToBytes(`0F0F0003${add ? '00' : '01'}00000000`);
  const sighashBytes = hexToBytes(hash);
  const idBuf = new Uint8Array(4);
  const view = new DataView(idBuf.buffer);
  view.setUint32(0, userId, false);
  const message = concatBytes(prefix, sighashBytes, idBuf);
  if (message.length > 80) throw new Error('Github message exceeds 80 bytes');
  return message;
}
