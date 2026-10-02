#!/usr/bin/env node

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const modUrl = pathToFileURL(path.join(__dirname, '../../native/ui/lib/nft.js')).href;
  const {
    buildNftSymbolNameBytes,
    stableStringify,
    NFT_PREFIX_HEX,
    bytesToHex,
  } = await import(modUrl);

  const canonical = stableStringify({ b: 2, a: 1 });
  assert.strictEqual(canonical, '{"a":1,"b":2}');
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  const built = buildNftSymbolNameBytes('01020304', hash);
  assert.strictEqual(built.symbolBytes.length, 10);
  assert.strictEqual(built.nameBytes.length, 30);
  assert.strictEqual(bytesToHex(built.nftBytes).slice(0, 8), NFT_PREFIX_HEX);
  assert.strictEqual(bytesToHex(built.symbolBytes).slice(0, 8), NFT_PREFIX_HEX);

  assert.throws(() => buildNftSymbolNameBytes('123', hash), /8 hex/);
  console.log('[native:nft-test] PASS');
  console.log(`[native:nft-test] hash ${hash}`);
}

main().catch((error) => {
  console.error('[native:nft-test] FAIL', error && error.stack ? error.stack : error);
  process.exit(1);
});
