/**
 * QRL NFT helpers — NFTs are token creates with symbol prefix 00FF00FF.
 * Layout: [00FF00FF (4)][providerId (4)][sha256(json) (32)] = 40 bytes
 * symbol = bytes[0..10), name = bytes[10..40)
 */

export const NFT_PREFIX_HEX = '00ff00ff';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function hexToBytes(hex) {
  const clean = String(hex || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Invalid hex');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildNftSymbolNameBytes(providerIdHex, cryptoHashHex) {
  let provider = String(providerIdHex || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(provider)) {
    throw new Error('Provider id must be 8 hex characters (4 bytes)');
  }
  const hash = String(cryptoHashHex || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error('NFT content hash must be 64 hex characters');
  }
  const nftBytes = hexToBytes(`${NFT_PREFIX_HEX}${provider}${hash}`);
  if (nftBytes.length !== 40) throw new Error('NFT byte length must be 40');
  return {
    symbolBytes: nftBytes.slice(0, 10),
    nameBytes: nftBytes.slice(10, 40),
    nftBytes,
    providerId: provider,
    contentHash: hash,
  };
}

export async function sha256HexOfText(text) {
  const data = new TextEncoder().encode(String(text));
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return bytesToHex(new Uint8Array(digest));
  }
  throw new Error('Web Crypto SHA-256 unavailable');
}

export async function buildNftFromJson(providerIdHex, jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_) {
    throw new Error('NFT metadata must be valid JSON');
  }
  const canonical = stableStringify(parsed);
  const contentHash = await sha256HexOfText(canonical);
  return {
    ...buildNftSymbolNameBytes(providerIdHex, contentHash),
    canonicalJson: canonical,
  };
}

export function isNftToken(token) {
  if (!token) return false;
  if (token.is_nft) return true;
  const symbol = String(token.symbol || '');
  return symbol.toLowerCase().startsWith(NFT_PREFIX_HEX)
    || (typeof token.symbol_hex === 'string' && token.symbol_hex.toLowerCase().startsWith(NFT_PREFIX_HEX));
}
