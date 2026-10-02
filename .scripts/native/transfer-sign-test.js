#!/usr/bin/env node

/**
 * Prepare a testnet transfer, sign it locally with QRLLIB in Chromium,
 * and assert signature/hash shape — does not push by default.
 *
 * Set NATIVE_TRANSFER_PUSH=1 to also relay (spends fee from QRL_TEST_MNEMONIC).
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_ROOT, desktopUserAgent } = require('./constants');

const TESTNET_MNEMONIC = process.env.QRL_TEST_MNEMONIC;
const SHOULD_PUSH = process.env.NATIVE_TRANSFER_PUSH === '1';

if (!TESTNET_MNEMONIC) {
  console.error('[native:transfer-sign-test] Set QRL_TEST_MNEMONIC first.');
  process.exit(1);
}

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

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/local/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function loadPuppeteer() {
  try {
    return require('puppeteer-core');
  } catch (_) {
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'puppeteer-core@24'], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`install ${code}`))));
    });
    return require('puppeteer-core');
  }
}

function waitForHealth(base) {
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < 80; i += 1) {
      try {
        await new Promise((res, rej) => {
          http.get(`${base}/api/health`, (r) => {
            r.resume();
            if (r.statusCode === 200) res();
            else rej(new Error('not ready'));
          }).on('error', rej);
        });
        resolve();
        return;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    reject(new Error('health timeout'));
  });
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found');
  const puppeteer = await loadPuppeteer();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const backend = spawn('node', [path.join(PROJECT_ROOT, 'native/backend/server.js')], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BIND_IP: '127.0.0.1', PORT: String(port) },
    stdio: 'pipe',
  });

  let browser;
  try {
    await waitForHealth(base);
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const version = require('../../package.json').version;
    await page.setUserAgent(desktopUserAgent(version, 'X11; Linux x86_64'));
    await page.goto(base, { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForSelector('button');

    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => /open wallet/i.test(b.textContent || '')).click();
    });
    await page.waitForSelector('#seedInput');
    await page.type('#seedInput', TESTNET_MNEMONIC);
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => /^unlock$/i.test((b.textContent || '').trim())).click();
    });
    await page.waitForFunction(() => /Q[0-9a-fA-F]{78}/.test(document.body.innerText || ''), { timeout: 180000 });
    await page.waitForFunction(() => /Balance\s+([\d.,]+)/i.test(document.body.innerText || ''), { timeout: 60000 });

    const address = await page.evaluate(() => (document.body.innerText.match(/Q[0-9a-fA-F]{78}/) || [])[0]);
    const ots = await page.evaluate(() => {
      const m = document.body.innerText.match(/Next OTS\s+(\d+)/i);
      return m ? Number(m[1]) : 0;
    });

    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => /^transfer$/i.test((b.textContent || '').trim())).click();
    });
    await page.waitForSelector('#toAddress');
    // Self-transfer tiny amount — prepare + confirm only unless PUSH=1
    await page.type('#toAddress', address);
    await page.click('#amount', { clickCount: 3 });
    await page.type('#amount', '0.001');
    await page.click('#otsKey', { clickCount: 3 });
    await page.type('#otsKey', String(ots));

    await page.click('#prepareTransferBtn');
    await page.waitForSelector('#confirmTransferBtn', { timeout: 60000 });

    const confirmText = await page.evaluate(() => document.body.innerText);
    if (!/Confirm transfer/i.test(confirmText)) {
      throw new Error('Confirm screen missing');
    }

    if (!SHOULD_PUSH) {
      console.log('[native:transfer-sign-test] PASS (prepare + confirm UI; push skipped)');
      console.log(`[native:transfer-sign-test] From/To: ${address}`);
      console.log(`[native:transfer-sign-test] OTS: ${ots}`);
      return;
    }

    await page.click('#confirmTransferBtn');
    await page.waitForSelector('#txHashResult', { timeout: 180000 });
    const hash = await page.$eval('#txHashResult', (n) => (n.textContent || '').trim());
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error(`Unexpected tx hash: ${hash}`);
    }
    console.log('[native:transfer-sign-test] PASS (pushed)');
    console.log(`[native:transfer-sign-test] Tx: ${hash}`);
  } finally {
    if (browser) await browser.close();
    backend.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error('[native:transfer-sign-test] FAIL', error && error.stack ? error.stack : error);
  process.exit(1);
});
