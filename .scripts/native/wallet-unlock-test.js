#!/usr/bin/env node

/**
 * Functional test: open a testnet wallet from mnemonic via the native UI stack.
 * Asserts checksummed address (Q+78 hex), non-placeholder balance, and Next OTS.
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

const ADDRESS_RE = /Q[0-9a-fA-F]{78}/;

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

function getJson(base, pathname) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${pathname}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`${pathname} → ${res.statusCode}: ${body.slice(0, 120)}`));
          return;
        }
        resolve({ contentType: res.headers['content-type'] || '', body });
      });
    }).on('error', reject);
  });
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome/Chromium not found');

  const vendorPath = path.join(PROJECT_ROOT, 'public', 'vendor', 'qrllib', 'offline-libjsqrl.js');
  if (!fs.existsSync(vendorPath)) {
    const fromNpm = path.join(PROJECT_ROOT, 'node_modules', 'qrllib', 'build', 'offline-libjsqrl.js');
    if (!fs.existsSync(fromNpm)) {
      throw new Error('Missing public/vendor/qrllib/offline-libjsqrl.js');
    }
    fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
    fs.copyFileSync(fromNpm, vendorPath);
    console.log('[native:wallet-test] Copied offline-libjsqrl.js into public/vendor');
  }

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

    const qrllibAsset = await getJson(base, '/vendor/qrllib/offline-libjsqrl.js');
    if (!/javascript|ecmascript/i.test(qrllibAsset.contentType)
      && !qrllibAsset.body.includes('QRLLIB=Module')) {
      throw new Error('QRLLIB asset not served correctly from /vendor/qrllib/offline-libjsqrl.js');
    }
    if (!qrllibAsset.body.includes('QRLLIB=Module')) {
      throw new Error('QRLLIB asset body missing QRLLIB=Module assignment');
    }

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    const pageErrors = [];
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
      const hasAddress = /Q[0-9a-fA-F]{78}/.test(text);
      const hasBalance = /Balance[\s\S]*?([\d.,]+)\s*Quanta/i.test(text);
      const hasOts = /Next OTS[\s\S]*?\d+/i.test(text);
      const balancePlaceholder = /Balance[\s\S]*?—\s*Quanta/i.test(text);
      const otsPlaceholder = /Next OTS[\s\S]*?—/i.test(text);
      return hasAddress && hasBalance && hasOts && !balancePlaceholder && !otsPlaceholder;
    }, { timeout: 180000 });

    const snapshot = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const address = (text.match(/Q[0-9a-fA-F]{78}/) || [])[0] || null;
      const balanceMatch = text.match(/Balance\s*([\d.,]+)\s*Quanta/i);
      const otsMatch = text.match(/Next OTS\s*(\d+)/i);
      return {
        address,
        balanceText: balanceMatch ? balanceMatch[1] : null,
        nextOts: otsMatch ? Number(otsMatch[1]) : null,
        desktop: window.__QRL_NATIVE_DESKTOP__ === true,
        bodyPreview: text.slice(0, 800),
      };
    });

    if (!snapshot.address || !ADDRESS_RE.test(snapshot.address)) {
      throw new Error(`Expected checksummed Q+78 hex address, got: ${snapshot.address}`);
    }
    if (!snapshot.balanceText) {
      throw new Error(`Balance missing after unlock. Preview:\n${snapshot.bodyPreview}`);
    }
    if (snapshot.nextOts == null || Number.isNaN(snapshot.nextOts)) {
      throw new Error(`Next OTS missing after unlock. Preview:\n${snapshot.bodyPreview}`);
    }
    if (pageErrors.length) {
      console.warn('[native:wallet-test] page errors:', pageErrors.slice(0, 5));
    }

    console.log('[native:wallet-test] PASS');
    console.log(`[native:wallet-test] Address: ${snapshot.address}`);
    console.log(`[native:wallet-test] Balance: ${snapshot.balanceText} Quanta`);
    console.log(`[native:wallet-test] Next OTS: ${snapshot.nextOts}`);
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
