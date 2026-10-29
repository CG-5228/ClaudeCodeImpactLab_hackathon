'use strict';
// Local dashboard server: static files from src/dashboard/public plus the JSON API under
// /api (api.js). Loopback only, no CORS headers ever, security headers on every response,
// a custom request header on every mutation, no outbound requests except the wellness
// chat's Claude API calls (chat.js). Started by `stopcode serve`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { StopCode } = require('../core/domain');
const { loadDotenv } = require('./dotenv');
const { createApi } = require('./api');
const { createChat } = require('./chat');
const U = require('./http-util');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'dashboard', 'public');
const DEFAULT_PORT = 4821;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Only these file types are served; anything else under public/ answers 404.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function log(line) {
  process.stderr.write(`${line}\n`);
}

// Best-effort browser launch; failures are ignored (the URL is printed by the CLI anyway).
function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
    const child = execFile(cmd, args, { windowsHide: true }, () => {});
    child.on('error', () => {});
    if (typeof child.unref === 'function') child.unref();
  } catch (e) {
    /* ignore */
  }
}

// Maps a request path to a file inside publicDir. Returns null when the path escapes the
// directory (after decoding and normalisation) or has a type the dashboard does not serve.
function resolveStatic(publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  const root = path.resolve(publicDir);
  const abs = path.resolve(root, `.${decoded}`);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const type = MIME[path.extname(abs).toLowerCase()];
  if (!type) return null;
  return { abs, type };
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function serveStatic(req, res, publicDir, pathname, method) {
  const target = resolveStatic(publicDir, pathname);
  const isRoot = pathname === '/' || pathname === '/index.html';
  const notFound = () => sendText(res, 404, isRoot ? `StopCode dashboard files were not found in ${publicDir}.` : 'Not found');
  if (!target) return notFound();
  return fs.stat(target.abs, (err, st) => {
    if (err || !st.isFile()) return notFound();
    res.statusCode = 200;
    res.setHeader('Content-Type', target.type);
    res.setHeader('Content-Length', st.size);
    res.setHeader('Cache-Control', 'no-cache');
    if (method === 'HEAD') return res.end();
    const stream = fs.createReadStream(target.abs);
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  });
}

// Builds the (req, res) listener. `allowedOrigins` is a function so the real port is
// known even when the server was started with port 0.
function createRequestHandler({ sc, chat, api, publicDir = PUBLIC_DIR, allowedOrigins = () => [], logger = log } = {}) {
  const core = sc || new StopCode();
  const chatService = chat || createChat({ sc: core, log: logger });
  const apiService = api || createApi({ sc: core, chat: chatService });

  async function dispatch(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch (e) {
      throw new U.HttpError(400, 'bad_request', 'Malformed request URL');
    }
    // Cross-origin protection: a present Origin must be this server; every mutation must
    // carry the custom header (browsers never add it to cross-site form posts).
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().includes(String(origin))) throw new U.HttpError(403, 'forbidden', 'Cross-origin requests are not allowed');
    const mutation = method !== 'GET' && method !== 'HEAD';
    if (mutation && String(req.headers['x-stopcode-request'] || '') !== '1') throw new U.HttpError(403, 'forbidden', 'Missing X-StopCode-Request header');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return apiService.handle(req, res, { method, url });
    if (mutation) throw new U.HttpError(405, 'method_not_allowed', `${method} is not supported for static files`);
    return serveStatic(req, res, publicDir, url.pathname, method);
  }

  return function handler(req, res) {
    U.setSecurityHeaders(res);
    dispatch(req, res).catch((err) => {
      const { status, body } = U.errorResponse(err);
      // Stack traces go to stderr only; clients get the generic message.
      if (status === 500) logger(`stopcode server: ${req.method} ${req.url} failed: ${err && err.stack ? err.stack : err}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (status === 413) res.setHeader('Connection', 'close');
      U.sendJson(res, status, body);
    });
  };
}

// Starts the dashboard server. Resolves with { server, url, port, close() }.
async function startServer({ port = DEFAULT_PORT, host = '127.0.0.1', open = false, dataDir } = {}) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`StopCode binds to the loopback interface only; "${host}" is not allowed`);
  const dotenv = loadDotenv();
  if (dotenv.loaded && dotenv.applied.length) log(`stopcode: loaded ${dotenv.applied.join(', ')} from ${dotenv.file} (values are never logged)`);
  const sc = new StopCode({ dataDir });
  const chat = createChat({ sc });
  const api = createApi({ sc, chat });
  let boundPort = Number.isFinite(Number(port)) ? Number(port) : DEFAULT_PORT;
  const hostLabel = host === '::1' ? '[::1]' : host;
  // "localhost" may resolve to ::1 on some systems; bind the IPv4 loopback explicitly so
  // the printed URL and the Origin allow-list always match the listening socket.
  const bindHost = host === 'localhost' ? '127.0.0.1' : host;
  const allowedOrigins = () => [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, ...(host === '::1' ? [`http://[::1]:${boundPort}`] : [])];
  const server = http.createServer(createRequestHandler({ sc, chat, api, allowedOrigins }));
  await new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(boundPort, bindHost, () => {
      server.off('error', onError);
      resolve();
    });
  });
  boundPort = server.address().port;
  const url = `http://${hostLabel}:${boundPort}/`;
  if (open) openBrowser(url);
  return {
    server,
    url,
    port: boundPort,
    host,
    dataDir: sc.dataDir,
    publicDir: PUBLIC_DIR,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }),
  };
}

module.exports = { startServer, createRequestHandler, resolveStatic, openBrowser, PUBLIC_DIR, DEFAULT_PORT, MIME };
