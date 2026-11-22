/** Real Chromium native-form regression, disposable Docker only.
 * node infra/preview/gateway/test_native_form.cjs
 * Requires installed Playwright and local gate/Caddy images, free loopback443.
 * Never pulls an image, accesses AWS/app services, reads deployment credentials,
 * weakens gate.py, overrides Origin, or prints invitation/cookie values.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '../../..');
const gateImage = 'learnsdlc-preview-gate:local';
const caddyImage = 'caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648';
const prefix = `learnsdlc-native-form-${crypto.randomBytes(5).toString('hex')}`;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
const reportPath = path.join(directory, 'report.json');
const origin = 'https://localhost';
const desktopSocket = path.join(os.homedir(), '.docker/run/docker.sock');
const env = { ...process.env, DOCKER_CONFIG: process.env.DOCKER_CONFIG || path.join(root, 'data/docker-client'),
  ...(!process.env.DOCKER_HOST && fs.existsSync(desktopSocket) ? { DOCKER_HOST: 'unix://' + desktopSocket } : {}) };
const report = { scope: 'Real Chromium native forms; disposable TLS Caddy/gate and fabricated upstream only; no cloud/application requests', checks: [] };
const containers = [];
let browser, networkCreated = false;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const protectedFiles = [path.join(__dirname, 'gate.py'), path.join(root, 'infra/preview/Caddyfile')];
const originalHashes = protectedFiles.map(hash);
const token = crypto.randomBytes(32).toString('base64url');
const config = { signing_key: crypto.randomBytes(32).toString('base64url'), invites: [
  { token_sha256: crypto.createHash('sha256').update(token).digest('hex'), expires_at: Math.floor(Date.now() / 1000) + 3600 }
] };
function check(name, condition, detail) {
  if (!condition) throw new Error(`Assertion failed: ${name}`);
  report.checks.push({ name, passed: true, ...(detail ? { detail } : {}) });
}
function docker(...args) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`Disposable Docker ${args[0]} failed (diagnostic suppressed)`);
  return result.stdout.trim();
}
function start(suffix, ...args) {
  const name = prefix + '-' + suffix;
  containers.push(name);
  docker('run', '-d', '--pull=never', '--name', name, '--network', prefix, ...args);
  return name;
}
function bind(source, target) { return `type=bind,source=${source},target=${target},readonly`; }
async function freePort() {
  await new Promise((resolve, reject) => {
    // Docker Desktop's privileged helper publishes443; this unprivileged Node
    // process can only probe it. Docker still fails if another owner wins it.
    const socket = net.connect({ host: '127.0.0.1', port: 443 });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('Loopback443 already in use')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Loopback443 probe timed out')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('Loopback443 probe failed')));
  });
}
async function context() {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  await ctx.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'));
  return ctx;
}
async function post(page, submit) {
  const responsePromise = page.waitForResponse(r => r.url() === origin + '/_preview/access' && r.request().method() === 'POST');
  await submit();
  const response = await responsePromise;
  return { response, headers: await response.request().allHeaders() };
}

(async () => {
  try {
    await freePort();
    docker('image', 'inspect', gateImage); docker('image', 'inspect', caddyImage);
    const fixtures = path.join(directory, 'fixtures'); fs.mkdirSync(fixtures, { mode: 0o755 });
    const template = fs.readFileSync(path.join(__dirname, 'access.html'), 'utf8');
    check('Source declares only origin referrer policy', template.includes('<meta name="referrer" content="strict-origin">'));
    // Baseline changes only the disposable copy; the real source stays fixed.
    const htmlFile = path.join(fixtures, 'access.html');
    fs.writeFileSync(htmlFile, template.replace('<meta name="referrer" content="strict-origin">', ''), { mode: 0o644 });
    fs.copyFileSync(path.join(__dirname, 'gate.py'), path.join(fixtures, 'gate.py'));
    const secretFile = path.join(fixtures, 'preview-gate.json');
    fs.writeFileSync(secretFile, JSON.stringify(config), { mode: 0o644 });
    fs.writeFileSync(path.join(fixtures, 'upstream.py'), `from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  body=b'<!doctype html><title>Disposable accepted preview</title><main>Invitation accepted.</main>'
  self.send_response(200); self.send_header('Content-Type','text/html'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
ThreadingHTTPServer(('0.0.0.0',3000),Handler).serve_forever()
`, { mode: 0o644 });
    docker('network', 'create', prefix); networkCreated = true;
    const gate = start('gate', '--network-alias', 'preview-gate', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '-e', 'GATE_SITE_HOST=localhost', '--mount', bind(fixtures, '/opt/preview-gate'), '--mount', bind(fixtures, '/run/secrets'), gateImage);
    start('upstream', '--network-alias', 'web', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--mount', bind(path.join(fixtures, 'upstream.py'), '/tmp/upstream.py'), gateImage, 'python', '/tmp/upstream.py');
    const caddy = start('caddy', '-e', 'SITE_HOST=localhost', '-p', '127.0.0.1:443:443', '--tmpfs', '/data', '--tmpfs', '/config',
      '--mount', bind(path.join(root, 'infra/preview/Caddyfile'), '/etc/caddy/Caddyfile'), caddyImage);
    browser = await chromium.launch({ headless: true });
    let ctx = await context(), page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    for (let attempt = 0; attempt < 40; attempt++) {
      try { if ((await ctx.request.get(origin + '/_preview/access')).status() === 200) break; } catch {}
      if (attempt === 39) throw new Error('Disposable Caddy did not become ready');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await page.goto(origin + '/_preview/access');
    await page.locator('#code').fill(token);
    let sent = await post(page, () => page.getByRole('button', { name: 'Enter the preview' }).click());
    check('Baseline native POST reproduces null Origin and403', sent.response.status() === 403 && sent.headers.origin === 'null');
    check('Baseline sets no invitation cookie', (await ctx.cookies()).length === 0);
    await ctx.close();

    fs.writeFileSync(htmlFile, template);
    check('Container observes the exact fixed template', docker('exec', gate, 'python', '-c',
      "import hashlib;print(hashlib.sha256(open('access.html','rb').read()).hexdigest())") === hash(htmlFile));
    ctx = await context(); page = await ctx.newPage();
    const entry = await page.goto(origin + '/_preview/access?view=native-form');
    check('Global HTTP referrer policy remains no-referrer', entry.headers()['referrer-policy'] === 'no-referrer');
    await page.locator('#code').fill(token);
    sent = await post(page, () => page.getByRole('button', { name: 'Enter the preview' }).click());
    await page.waitForURL(origin + '/');
    check('Fixed native POST carries exact same-origin Origin', sent.headers.origin === origin);
    check('Native form referrer contains origin only', sent.headers.referer === origin + '/');
    check('Accepted form redirects303 to clean root', sent.response.status() === 303 && sent.response.headers().location === '/' && page.url() === origin + '/');
    check('Exchange retains no-referrer/no-store', sent.response.headers()['referrer-policy'] === 'no-referrer' && sent.response.headers()['cache-control'].includes('no-store'));
    const cookies = await ctx.cookies(); const cookie = cookies.find(c => c.name === '__Host-learnsdlc-preview');
    check('Browser adopts Secure HttpOnly host-only Lax cookie', cookie && cookie.secure && cookie.httpOnly && cookie.path === '/' && cookie.domain === 'localhost' && cookie.sameSite === 'Lax');
    check('Cookie cannot be read by document script', await page.evaluate(() => document.cookie === ''));
    check('Accepted document contains no invitation or cookie value', !(await page.content()).includes(token) && !(await page.content()).includes(cookie.value));
    await ctx.close();

    ctx = await context(); page = await ctx.newPage();
    await page.goto(origin + '/_preview/access'); await page.locator('#code').fill(crypto.randomBytes(32).toString('base64url'));
    sent = await post(page, () => page.getByRole('button', { name: 'Enter the preview' }).click());
    check('Invalid code with correct Origin remains403', sent.response.status() === 403 && sent.headers.origin === origin && (await ctx.cookies()).length === 0);
    await ctx.close();

    {
      ctx = await context(); page = await ctx.newPage();
      // The attacker fixture is intercepted locally; only its native POST
      // leaves Playwright, to the disposable gate. No Origin header override.
      const form = `<form method="post" action="${origin}/_preview/access"><input name="code" value="${token}" type="hidden"><button>Send</button></form>`;
      await ctx.route('https://attacker.test/', route => route.fulfill({ contentType: 'text/html', body: form }));
      await page.goto('https://attacker.test/');
      sent = await post(page, () => page.getByRole('button', { name: 'Send' }).click());
      check('Cross-origin native form remains403',
        sent.response.status() === 403 && sent.headers.origin === 'https://attacker.test' && (await ctx.cookies()).length === 0);
      await ctx.close();
    }

    // Explicit protocol negatives use the HTTP client, not a browser header
    // override. Real native null-Origin behavior is already reproduced above.
    ctx = await context();
    for (const badOrigin of ['null', null]) {
      const denied = await ctx.request.post(origin + '/_preview/access', {
        headers: badOrigin ? { Origin: badOrigin } : {}, form: { code: token }, maxRedirects: 0,
      });
      check(badOrigin ? 'Explicit null-Origin HTTP request remains403' : 'Missing-Origin HTTP request remains403',
        denied.status() === 403 && (await ctx.cookies()).length === 0);
    }
    await ctx.close();

    ctx = await context(); page = await ctx.newPage();
    const rootRequest = page.waitForRequest(req => req.url() === origin + '/');
    const exchange = await ctx.request.get(origin + '/_preview/access/' + token, { maxRedirects: 0 });
    check('Invitation URL exchange keeps303/no-referrer', exchange.status() === 303 && exchange.headers()['referrer-policy'] === 'no-referrer');
    await ctx.clearCookies();
    await page.goto(origin + '/_preview/access/' + token);
    const cleanRequest = await rootRequest;
    check('Invitation redirect sends no token-bearing Referer', !(await cleanRequest.allHeaders()).referer && page.url() === origin + '/');
    config.invites[0].revoked = true;
    fs.writeFileSync(secretFile, JSON.stringify(config));
    check('Revocation is visible to gate', docker('exec', gate, 'python', '-c', "from gate import Gate;print(Gate('/run/secrets/preview-gate.json','localhost').config()[1][0]['revoked'])") === 'True');
    check('Existing browser cookie denied after revocation', (await page.goto(origin + '/')).status() === 403);
    await ctx.close();
    for (const container of [gate, caddy]) {
      const logs = docker('logs', container);
      check('No invitation or cookie in ' + (container === gate ? 'gate' : 'Caddy') + ' logs', !logs.includes(token) && !logs.includes(cookie.value));
    }
    check('Server Origin validation and global Caddy unchanged', protectedFiles.every((file, index) => hash(file) === originalHashes[index]));
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    // Arbitrary Playwright errors can contain input values/URLs. Never print them.
    report.failure = error.message?.startsWith('Assertion failed:') ? error.message : 'Disposable setup or browser operation failed; inspect the last completed check';
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    let removed = true;
    for (const container of containers.reverse()) removed = spawnSync('docker', ['rm', '-f', '-v', container], { env, stdio: 'ignore', timeout: 30000 }).status === 0 && removed;
    if (networkCreated) removed = spawnSync('docker', ['network', 'rm', prefix], { env, stdio: 'ignore', timeout: 30000 }).status === 0 && removed;
    fs.rmSync(path.join(directory, 'fixtures'), { recursive: true, force: true });
    report.browserClosed = true; report.disposableResourcesRemoved = removed;
    if (!removed) { report.status = 'failed'; report.failure = 'Disposable Docker cleanup did not complete'; process.exitCode = 1; }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: reportPath, failure: report.failure }));
  }
})();
