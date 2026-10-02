#!/usr/bin/env node

/**
 * Unit checks for Meteor-compatible document notarisation encoding.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const modUrl = pathToFileURL(path.join(__dirname, '../../native/ui/lib/notarise.js')).href;
  const {
    buildNotarisationHex,
    notarisationHexToMessageBytes,
    NOTARISE_PREFIX,
    NOTARISE_HASH_SHA256,
  } = await import(modUrl);

  const sample = Buffer.from('qrl-native-notarise-fixture');
  const fileHash = crypto.createHash('sha256').update(sample).digest('hex');
  const hex = buildNotarisationHex({
    fileHashHex: fileHash,
    additionalText: 'hello',
    hashFunction: 'SHA256',
  });

  assert.ok(hex.startsWith(`${NOTARISE_PREFIX}${NOTARISE_HASH_SHA256}`), 'prefix');
  assert.ok(hex.includes(fileHash), 'includes file hash');
  assert.strictEqual(hex.slice(0, 6).toLowerCase(), 'afafa2');

  const bytes = notarisationHexToMessageBytes(hex);
  assert.ok(bytes.length <= 80, 'message ≤ 80 bytes');
  assert.strictEqual(bytes.length, 3 + 32 + 5); // AFAFA2 + sha256 + "hello"

  assert.throws(() => buildNotarisationHex({ fileHashHex: 'deadbeef', additionalText: '' }), /64 hex/);
  assert.throws(
    () => buildNotarisationHex({
      fileHashHex: fileHash,
      additionalText: 'x'.repeat(46),
    }),
    /max length/i,
  );

  console.log('[native:notarise-test] PASS');
  console.log(`[native:notarise-test] sample hash ${fileHash}`);
  console.log(`[native:notarise-test] message bytes ${bytes.length}`);
}

main().catch((error) => {
  console.error('[native:notarise-test] FAIL', error && error.stack ? error.stack : error);
  process.exit(1);
});
