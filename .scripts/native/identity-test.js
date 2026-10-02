#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const modUrl = pathToFileURL(path.join(__dirname, '../../native/ui/lib/identity.js')).href;
  const { buildKeybaseMessageBytes, buildGithubMessageBytes } = await import(modUrl);

  const kb = buildKeybaseMessageBytes({
    keybaseId: 'alice',
    sigHash: 'ab'.repeat(33),
    add: true,
  });
  assert.strictEqual(kb[0], 0x0f);
  assert.strictEqual(kb[1], 0x0f);
  assert.ok(kb.length <= 80);

  const gh = buildGithubMessageBytes({
    githubUserId: 12345,
    sigHash: 'cd'.repeat(33),
    add: false,
  });
  assert.strictEqual(gh[0], 0x0f);
  assert.strictEqual(gh[4], 0x01); // remove
  // prefix 0F0F0003 + 01 + 00000000 = 9 bytes + 33 sighash + 4 id
  assert.strictEqual(gh.length, 9 + 33 + 4);

  assert.throws(() => buildKeybaseMessageBytes({ keybaseId: 'x', sigHash: 'aa', add: true }), /66 hex/);
  assert.throws(() => buildGithubMessageBytes({ githubUserId: 0, sigHash: 'cd'.repeat(33), add: true }), /positive/);

  console.log('[native:identity-test] PASS');
  console.log(`[native:identity-test] keybase bytes ${kb.length}, github bytes ${gh.length}`);
}

main().catch((error) => {
  console.error('[native:identity-test] FAIL', error && error.stack ? error.stack : error);
  process.exit(1);
});
