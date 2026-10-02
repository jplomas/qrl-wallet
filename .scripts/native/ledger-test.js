#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const ledger = require(path.join(__dirname, '../../native/backend/ledger.js'));

function main() {
  const fee = ledger.u64Buffer(1000000);
  assert.strictEqual(fee.length, 8);
  assert.strictEqual(fee.toString('hex'), '00000000000f4240');

  const fromBytes = ledger.u64Buffer([0, 0, 0, 0, 0, 15, 66, 64]);
  assert.strictEqual(fromBytes.toString('hex'), '00000000000f4240');

  const serialized = ledger.serializeLedgerValue({
    public_key: Buffer.from('abcd', 'hex'),
    nested: { signature: Uint8Array.from([1, 2]) },
  });
  assert.strictEqual(serialized.public_key, 'abcd');
  assert.strictEqual(serialized.nested.signature, '0102');

  assert.throws(() => ledger.u64Buffer(-1), /Invalid uint64/);
  assert.throws(() => ledger.u64Buffer(Buffer.alloc(4)), /8 bytes/);

  console.log('[native:ledger-test] PASS');
}

main();
