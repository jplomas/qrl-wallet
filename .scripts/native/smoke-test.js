#!/usr/bin/env node

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_ROOT, desktopUserAgent } = require('./constants');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body || '{}'), body });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const port = await freePort();
  const host = '127.0.0.1';
  const base = `http://${host}:${port}`;

  const child = spawn('node', [path.join(PROJECT_ROOT, 'native', 'backend', 'server.js')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      BIND_IP: host,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    let ready = false;
    for (let i = 0; i < 80; i += 1) {
      try {
        const health = await fetchJson(`${base}/api/health`);
        if (health.status === 200 && health.json.ok) {
          ready = true;
          break;
        }
      } catch (_) {
        // retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) {
      throw new Error(`Backend failed to become ready\n${stderr}`);
    }

    const networks = await fetchJson(`${base}/api/networks`);
    if (networks.status !== 200) throw new Error('networks endpoint failed');

    const connect = await postJson(`${base}/api/connect`, { network: 'testnet' });
    if (connect.status !== 200) {
      throw new Error(`connect failed: ${connect.body}`);
    }

    const home = await new Promise((resolve, reject) => {
      http.get(`${base}/`, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    if (home.status !== 200 || !home.body.includes('QRL Wallet')) {
      throw new Error('UI shell did not load');
    }

    const qr = await postJson(`${base}/api/qrSvg`, { text: 'Q000400test' });
    if (qr.status !== 200 || !qr.body.includes('"ok":true') || !qr.body.includes('<svg')) {
      throw new Error(`qrSvg failed: ${qr.body.slice(0, 200)}`);
    }

    // Token revive helpers (no network): ensure PushTransaction buffer revival for token txs
    const { reviveSignedTransaction } = require(path.join(PROJECT_ROOT, 'native/backend/api.js'));
    const revivedToken = reviveSignedTransaction({
      fee: '1000000',
      public_key: 'aa',
      signature: 'bb',
      token: {
        symbol: Buffer.from('SYM').toString('hex'),
        name: Buffer.from('Name').toString('hex'),
        owner: '000400' + '11'.repeat(36),
        decimals: '2',
        initial_balances: [{ address: '000400' + '22'.repeat(36), amount: '100' }],
      },
    });
    if (!Buffer.isBuffer(revivedToken.token.symbol) || revivedToken.token.symbol.toString() !== 'SYM') {
      throw new Error('token.symbol revive failed');
    }
    if (!Buffer.isBuffer(revivedToken.token.initial_balances[0].address)) {
      throw new Error('token.initial_balances address revive failed');
    }
    const revivedTransferToken = reviveSignedTransaction({
      fee: '1',
      transfer_token: {
        token_txhash: 'ab'.repeat(32),
        addrs_to: ['000400' + '33'.repeat(36)],
        amounts: ['5'],
      },
    });
    if (!Buffer.isBuffer(revivedTransferToken.transfer_token.token_txhash)) {
      throw new Error('transfer_token.token_txhash revive failed');
    }

    const forbidden = await new Promise((resolve, reject) => {
      http.get(`${base}/api/health`, { headers: { Host: 'evil.example:80' } }, (res) => {
        resolve(res.statusCode);
      }).on('error', reject);
    });
    if (forbidden !== 403) {
      throw new Error(`Expected Host rejection 403, got ${forbidden}`);
    }

    console.log('[native:smoke-test] PASS');
    console.log(`[native:smoke-test] Backend ${base}`);
    console.log(`[native:smoke-test] UA sample: ${desktopUserAgent(require('../../package.json').version, 'Linux x86_64')}`);
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error('[native:smoke-test] FAIL', error.message || error);
  process.exit(1);
});
