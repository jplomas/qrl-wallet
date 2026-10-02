#!/usr/bin/env node

/**
 * Token balances list + create-token prepare/confirm UI.
 * Does not push by default (NATIVE_TOKEN_PUSH=1 to relay).
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_ROOT, desktopUserAgent } = require('./constants');

const TESTNET_MNEMONIC = process.env.QRL_TEST_MNEMONIC;
const SHOULD_PUSH = process.env.NATIVE_TOKEN_PUSH === '1';

if (!TESTNET_MNEMONIC) {
  console.error('[native:token-sign-test] Set QRL_TEST_MNEMONIC first.');
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
    '/usr/bin/chromium-browser',
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

    const ots = await page.evaluate(() => {
      const m = document.body.innerText.match(/Next OTS\s+(\d+)/i);
      return m ? Number(m[1]) : 0;
    });

    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => /^tokens$/i.test((b.textContent || '').trim())).click();
    });
    await page.waitForFunction(
      () => /No tokens held|tokenBalancesTable|Create token/i.test(document.body.innerText || ''),
      { timeout: 90000 },
    );

    const listText = await page.evaluate(() => document.body.innerText);
    if (!/Tokens/i.test(listText) || !/Create token/i.test(listText)) {
      throw new Error('Tokens view missing');
    }

    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => /create token/i.test(b.textContent || '')).click();
    });
    await page.waitForSelector('#tokenSymbol');

    const symbol = `T${Date.now().toString(36).slice(-5)}`.toUpperCase();
    await page.type('#tokenSymbol', symbol);
    await page.type('#tokenName', 'NativeTest');
    await page.click('#tokenDecimals', { clickCount: 3 });
    await page.type('#tokenDecimals', '0');
    await page.click('#tokenSupply', { clickCount: 3 });
    await page.type('#tokenSupply', '10');
    await page.click('#tokenCreateOts', { clickCount: 3 });
    await page.type('#tokenCreateOts', String(ots));

    await page.click('#prepareTokenCreateBtn');
    await page.waitForSelector('#confirmTokenCreateBtn', { timeout: 90000 });

    const confirmText = await page.evaluate(() => document.body.innerText);
    if (!/Confirm token create/i.test(confirmText) || !confirmText.includes(symbol)) {
      throw new Error('Token create confirm screen missing');
    }

    if (!SHOULD_PUSH) {
      console.log('[native:token-sign-test] PASS (balances + create prepare/confirm; push skipped)');
      console.log(`[native:token-sign-test] Symbol: ${symbol}`);
      console.log(`[native:token-sign-test] OTS: ${ots}`);
      return;
    }

    await page.click('#confirmTokenCreateBtn');
    await page.waitForSelector('#tokenCreateTxHash', { timeout: 180000 });
    const hash = await page.$eval('#tokenCreateTxHash', (n) => (n.textContent || '').trim());
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error(`Unexpected token create hash: ${hash}`);
    }
    console.log('[native:token-sign-test] PASS (pushed)');
    console.log(`[native:token-sign-test] Tx: ${hash}`);
  } finally {
    if (browser) await browser.close();
    backend.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error('[native:token-sign-test] FAIL', error && error.stack ? error.stack : error);
  process.exit(1);
});
