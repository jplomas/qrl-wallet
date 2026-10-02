#!/usr/bin/env node

/**
 * Functional test: open a testnet wallet from mnemonic via the native UI stack.
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT_ROOT, desktopUserAgent } = require('./constants');

const TESTNET_MNEMONIC = process.env.QRL_TEST_MNEMONIC;
if (!TESTNET_MNEMONIC) {
  console.error('[native:wallet-test] Set QRL_TEST_MNEMONIC to a testnet mnemonic before running.');
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
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function loadPuppeteer() {
  try {
    return require('puppeteer-core');
  } catch (_) {
    console.log('[native:wallet-test] Installing puppeteer-core…');
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'puppeteer-core@24'], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`install failed ${code}`))));
    });
    return require('puppeteer-core');
  }
}

function waitForHealth(base, attempts = 80) {
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < attempts; i += 1) {
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
    reject(new Error('backend health timeout'));
  });
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome/Chromium not found');

  const puppeteer = await loadPuppeteer();
  const host = '127.0.0.1';
  const port = await freePort();
  const base = `http://${host}:${port}`;

  const backend = spawn('node', [path.join(PROJECT_ROOT, 'native', 'backend', 'server.js')], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BIND_IP: host, PORT: String(port) },
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
    await page.evaluateOnNewDocument(() => {
      window.__QRL_NATIVE_DESKTOP__ = true;
    });

    await page.goto(base, { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForSelector('button', { timeout: 30000 });

    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const open = buttons.find((b) => /open wallet/i.test(b.textContent || ''));
      if (!open) throw new Error('Open Wallet button missing');
      open.click();
    });

    await page.waitForSelector('#seedInput', { timeout: 15000 });
    await page.click('#seedInput', { clickCount: 3 });
    await page.type('#seedInput', TESTNET_MNEMONIC, { delay: 0 });

    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const unlock = buttons.find((b) => /^unlock$/i.test((b.textContent || '').trim()));
      if (!unlock) throw new Error('Unlock button missing');
      unlock.click();
    });

    await page.waitForFunction(() => {
      const text = document.body.innerText || '';
      return /Q[0-9a-fA-F]{72}/.test(text) && /Balance/i.test(text);
    }, { timeout: 180000 });

    const snapshot = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const match = text.match(/Q[0-9a-fA-F]{72}/);
      return {
        address: match ? match[0] : null,
        desktop: window.__QRL_NATIVE_DESKTOP__ === true,
      };
    });

    if (!snapshot.address) throw new Error('No wallet address after unlock');

    console.log('[native:wallet-test] PASS');
    console.log(`[native:wallet-test] Address: ${snapshot.address}`);
    console.log(`[native:wallet-test] Desktop flag: ${snapshot.desktop}`);
  } finally {
    if (browser) await browser.close();
    backend.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error('[native:wallet-test] FAIL', error && error.stack ? error.stack : error);
  process.exit(1);
});
