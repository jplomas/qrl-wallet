#!/usr/bin/env node
/**
 * QRL Wallet native local backend.
 * Loopback-only HTTP API + static UI. No Meteor, no Electron.
 *
 * Security posture:
 * - Bind 127.0.0.1 only (never 0.0.0.0)
 * - Reject non-local Host headers (DNS rebinding)
 * - Same-origin / loopback Origin checks for API writes
 * - gRPC endpoints allowlisted in grpc-client.js
 * - Seeds/keys never touch this process — signing stays in the renderer/WASM
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { BIND_HOST, PORT, UI_DIR, PUBLIC_DIR } = require('./config');
const { handlers } = require('./api');
const { version } = require('../../package.json');

const MAX_BODY_BYTES = 1_000_000;
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'", // qrllib/Emscripten still needs eval
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function securityHeaders(extra = {}) {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  }));
  res.end(payload);
}

function isLocalRequest(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return false;
  }

  const origin = req.headers.origin;
  if (!origin) {
    // Same-origin navigations and some WebView fetches omit Origin.
    return true;
  }

  try {
    const parsed = new URL(origin);
    return parsed.hostname === '127.0.0.1'
      || parsed.hostname === 'localhost'
      || parsed.hostname === '::1';
  } catch (_) {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const absolute = path.join(root, cleaned);
  if (!absolute.startsWith(root)) {
    return null;
  }
  return absolute;
}

function serveFile(res, filePath) {
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, securityHeaders({
    'Content-Type': type,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
  }));
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, methodName) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Mutating / privileged methods require POST.
  if (methodName !== 'health' && methodName !== 'networks' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'POST required' });
    return;
  }

  const handler = handlers[methodName];
  if (!handler) {
    sendJson(res, 404, { error: `Unknown method: ${methodName}` });
    return;
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await handler(body);
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'Forbidden host/origin' });
        return;
      }

      const url = new URL(req.url || '/', `http://${BIND_HOST}:${PORT}`);

      if (url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          version,
          name: 'qrl-wallet-native',
          desktop: true,
        });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const methodName = url.pathname.slice('/api/'.length).replace(/\/$/, '');
        await handleApi(req, res, methodName);
        return;
      }

      if (url.pathname.startsWith('/public/') || url.pathname.startsWith('/workers/')
        || url.pathname.startsWith('/img/') || url.pathname.startsWith('/fonts/')
        || url.pathname.startsWith('/vendor/')
        || url.pathname === '/tailwind-output.css') {
        const relative = url.pathname.startsWith('/public/')
          ? url.pathname.slice('/public/'.length)
          : url.pathname.slice(1);
        serveFile(res, safeJoin(PUBLIC_DIR, relative));
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        serveFile(res, path.join(UI_DIR, 'index.html'));
        return;
      }

      const uiPath = safeJoin(UI_DIR, url.pathname);
      if (uiPath && fs.existsSync(uiPath) && fs.statSync(uiPath).isFile()) {
        serveFile(res, uiPath);
        return;
      }

      serveFile(res, path.join(UI_DIR, 'index.html'));
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  });
}

function start(options = {}) {
  const host = options.host || BIND_HOST;
  const port = options.port || PORT;

  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error('[native-backend] Refusing to bind non-loopback host:', host);
    process.exit(1);
  }

  const server = createServer();
  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`[native-backend] QRL Wallet v${version} ready at ${url}`);
    console.log(`[native-backend] UI: ${UI_DIR}`);
    console.log(`[native-backend] Assets: ${PUBLIC_DIR}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { start, createServer };
