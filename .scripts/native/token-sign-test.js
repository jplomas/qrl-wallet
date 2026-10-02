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

function getAsset(base, pathname) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${pathname}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    }).on('error', reject);
  });
}

function ensureQrllibVendor() {
  const vendorPath = path.join(PROJECT_ROOT, 'public', 'vendor', 'qrllib', 'offline-libjsqrl.js');
  if (fs.existsSync(vendorPath)) return;
  const fromNpm = path.join(PROJECT_ROOT, 'node_modules', 'qrllib', 'build', 'offline-libjsqrl.js');
  if (!fs.existsSync(fromNpm)) {
    throw new Error('Missing public/vendor/qrllib/offline-libjsqrl.js');
  }
  fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
  fs.copyFileSync(fromNpm, vendorPath);
  console.log('[native:token-sign-test] Copied offline-libjsqrl.js into public/vendor');
}

async function dumpUnlockFailure(page, pageErrors, label) {
  const preview = await page.evaluate(() => ({
    text: (document.body.innerText || '').slice(0, 1200),
    hasSeed: Boolean(document.getElementById('seedInput')),
    alert: ([...document.querySelectorAll('[role=alert]')].map((n) => n.textContent || '').join(' | ')),
    qrllib: typeof QRLLIB !== 'undefined' && typeof QRLLIB.str2bin === 'function',
  })).catch(() => ({ text: '(unavailable)', hasSeed: null, alert: '', qrllib: null }));
  console.error(`[native:token-sign-test] ${label}`);
  console.error(`[native:token-sign-test] QRLLIB ready: ${preview.qrllib}`);
  console.error(`[native:token-sign-test] alert: ${preview.alert || '(none)'}`);
  console.error(`[native:token-sign-test] body preview:\n${preview.text}`);
  if (pageErrors.length) {
    console.error('[native:token-sign-test] page errors:', pageErrors.slice(0, 8));
  }
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found');
  ensureQrllibVendor();

  const puppeteer = await loadPuppeteer();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const backend = spawn('node', [path.join(PROJECT_ROOT, 'native/backend/server.js')], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BIND_IP: '127.0.0.1', PORT: String(port) },
    stdio: 'pipe',
  });

  let browser;
  const pageErrors = [];
  try {
    await waitForHealth(base);

    const qrllibAsset = await getAsset(base, '/vendor/qrllib/offline-libjsqrl.js');
    if (qrllibAsset.status !== 200 || !qrllibAsset.body.includes('QRLLIB=Module')) {
      throw new Error('QRLLIB asset not served correctly from /vendor/qrllib/offline-libjsqrl.js');
    }

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text());
    });

    const version = require('../../package.json').version;
    await page.setUserAgent(desktopUserAgent(version, 'X11; Linux x86_64'));
    await page.evaluateOnNewDocument(() => {
      window.__QRL_NATIVE_DESKTOP__ = true;
    });
    await page.goto(base, { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForSelector('button', { timeout: 30000 });

    // Wait for QRLLIB before opening — unlock depends on str2bin/Xmss.
    await page.waitForFunction(
      () => typeof QRLLIB !== 'undefined' && typeof QRLLIB.str2bin === 'function' && QRLLIB.Xmss,
      { timeout: 120000 },
    );

    await page.evaluate(() => {
      const open = [...document.querySelectorAll('button')]
        .find((b) => /open wallet/i.test(b.textContent || ''));
      if (!open) throw new Error('Open Wallet button missing');
      open.click();
    });
    await page.waitForSelector('#seedInput', { timeout: 15000 });
    await page.click('#seedInput', { clickCount: 3 });
    await page.type('#seedInput', TESTNET_MNEMONIC, { delay: 0 });
    await page.evaluate(() => {
      const unlock = [...document.querySelectorAll('button')]
        .find((b) => /^unlock$/i.test((b.textContent || '').trim()));
      if (!unlock) throw new Error('Unlock button missing');
      unlock.click();
    });

    try {
      await page.waitForFunction(() => {
        const text = document.body.innerText || '';
        return /Q[0-9a-fA-F]{78}/.test(text)
          && /Balance\s+([\d.,]+)/i.test(text)
          && /Next OTS\s+(\d+)/i.test(text);
      }, { timeout: 180000 });
    } catch (error) {
      await dumpUnlockFailure(page, pageErrors, 'wallet unlock timed out');
      throw error;
    }

    const ots = await page.evaluate(() => {
      const m = document.body.innerText.match(/Next OTS\s+(\d+)/i);
      return m ? Number(m[1]) : 0;
    });

    await page.evaluate(() => {
      const tokensBtn = [...document.querySelectorAll('button')]
        .find((b) => /^tokens$/i.test((b.textContent || '').trim()));
      if (!tokensBtn) throw new Error('Tokens button missing');
      tokensBtn.click();
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
      const createBtn = [...document.querySelectorAll('button')]
        .find((b) => /create token/i.test(b.textContent || ''));
      if (!createBtn) throw new Error('Create token button missing');
      createBtn.click();
    });
    await page.waitForSelector('#tokenSymbol', { timeout: 15000 });

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
    try {
      await page.waitForSelector('#confirmTokenCreateBtn', { timeout: 90000 });
    } catch (error) {
      const alert = await page.evaluate(() => (
        [...document.querySelectorAll('[role=alert]')].map((n) => n.textContent || '').join(' | ')
      ));
      console.error(`[native:token-sign-test] prepare failed alert: ${alert || '(none)'}`);
      throw error;
    }

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
