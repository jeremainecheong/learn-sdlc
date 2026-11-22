/**
 * The web service: the built front end, plus a proxy for /api.
 *
 * The proxy is why the browser never makes a cross-origin request and the API
 * never needs CORS: everything the page asks for is on the page's own origin,
 * and this process decides what is a file and what is the API. It is also
 * where the deployment goes wrong in interesting ways, because API_URL has to
 * name the API the way the network names it, not the way your laptop does.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const API_URL = process.env.API_URL || '';
const ROOT = path.join(__dirname, 'dist');
const INDEX = path.join(__dirname, 'index.html');

const TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function proxy(req, res) {
  if (!API_URL) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'no_api_url', message: 'The web service has no API_URL, so it has nowhere to send /api.' } }));
    return;
  }
  const target = new URL(req.url, API_URL);
  const upstream = http.request(
    { hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: { ...req.headers, host: target.host } },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', (failure) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'api_unreachable', message: `The web service could not reach the API at ${API_URL}: ${failure.message}` } }));
  });
  req.pipe(upstream);
}

function serveFile(res, file) {
  fs.readFile(file, (failure, body) => {
    if (failure) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/api' || req.url.startsWith('/api/')) return proxy(req, res);
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (rel === '/' || rel === '/index.html') return serveFile(res, INDEX);
  // Everything else is a file under dist/, and nothing is ever outside it:
  // path.join on "../../etc/passwd" resolves before this check, not after.
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden\n');
    return;
  }
  serveFile(res, file);
});

server.listen(PORT, HOST, () => {
  console.log(`web listening on http://${HOST}:${PORT}, proxying /api to ${API_URL || '(nothing)'}`);
});
