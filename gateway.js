const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 7357);
const TONA_PORT = Number(process.env.TONA_INTERNAL_PORT || 7358);
const TEAMFLOW_PORT = Number(process.env.TEAMFLOW_INTERNAL_PORT || 7359);
const OPENWORKER_PORT = Number(process.env.OPENWORKER_INTERNAL_PORT || 7360);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const TEAMFLOW_DATA_DIR = process.env.TEAMFLOW_DATA_DIR || path.join(DATA_DIR, 'teamflow');
const OPENWORKER_MODE = process.env.OPENWORKER_MODE || (process.env.NODE_ENV === 'production' ? 'embedded' : 'disabled');
const OPENWORKER_ENABLED = process.env.OPENWORKER_ENABLED !== 'false' && OPENWORKER_MODE !== 'disabled';
const OPENWORKER_STATE_DIR = process.env.OPENWORKER_STATE_DIR || path.join(DATA_DIR, 'openworker', 'state');
const OPENWORKER_WORKSPACE = process.env.OPENWORKER_WORKSPACE || path.join(DATA_DIR, 'openworker', 'workspace');
const OPENWORKER_API_TOKEN = process.env.OPENWORKER_API_TOKEN || crypto.randomBytes(32).toString('hex');
const children = new Map();
let shuttingDown = false;

function childEnvironment(name, port) {
  const env = { ...process.env, PORT: String(port) };
  if (name === 'tona') {
    env.DATA_DIR = DATA_DIR;
    env.TONA_HUB_AUTH_REQUIRED = 'true';
    env.TEAMFLOW_INTERNAL_PORT = String(TEAMFLOW_PORT);
    env.OPENWORKER_ENABLED = String(OPENWORKER_ENABLED);
    env.OPENWORKER_MODE = OPENWORKER_MODE;
    env.OPENWORKER_URL = process.env.OPENWORKER_URL || `http://127.0.0.1:${OPENWORKER_PORT}`;
    env.OPENWORKER_API_TOKEN = OPENWORKER_API_TOKEN;
    env.OPENWORKER_WORKSPACE = OPENWORKER_WORKSPACE;
  } else {
    env.DATA_DIR = TEAMFLOW_DATA_DIR;
    env.INITIAL_ADMIN_PASSWORD = process.env.TEAMFLOW_INITIAL_ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD || 'teamflow123';
    env.FEISHU_REMINDER_WEBHOOK = process.env.TEAMFLOW_FEISHU_REMINDER_WEBHOOK || process.env.FEISHU_REMINDER_WEBHOOK || '';
    env.APP_PUBLIC_URL = process.env.TEAMFLOW_PUBLIC_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/teamflow` : `http://localhost:${PORT}/teamflow`);
  }
  return env;
}

function startOpenWorker() {
  if (!OPENWORKER_ENABLED || OPENWORKER_MODE === 'remote' || shuttingDown) return;
  fs.mkdirSync(OPENWORKER_STATE_DIR, { recursive: true });
  fs.mkdirSync(OPENWORKER_WORKSPACE, { recursive: true });
  const bundledModule = path.join(ROOT, '.openworker', 'coworker', 'server', 'run.py');
  const dockerExecutable = '/opt/openworker/bin/openworker-server';
  const useBundledModule = !process.env.OPENWORKER_EXECUTABLE && fs.existsSync(bundledModule);
  const command = process.env.OPENWORKER_EXECUTABLE
    || (useBundledModule ? (process.env.OPENWORKER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')) : '')
    || (fs.existsSync(dockerExecutable) ? dockerExecutable : '')
    || 'openworker-server';
  const args = [
    ...(useBundledModule ? ['-m', 'coworker.server.run'] : []),
    '--cwd', OPENWORKER_WORKSPACE,
    '--host', '127.0.0.1',
    '--port', String(OPENWORKER_PORT),
    '--mode', process.env.OPENWORKER_DEFAULT_MODE || 'interactive'
  ];
  const env = {
    ...process.env,
    COWORKER_API_TOKEN: OPENWORKER_API_TOKEN,
    COWORKER_STATE_DIR: OPENWORKER_STATE_DIR,
    ...(useBundledModule ? { PYTHONPATH: [path.join(ROOT, '.openworker'), process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter) } : {})
  };
  const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.set('openworker', child);
  child.stdout.on('data', chunk => process.stdout.write(`[openworker] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[openworker] ${chunk}`));
  child.on('error', error => console.error(`[gateway] OpenWorker failed to start: ${error.message}`));
  child.on('exit', (code, signal) => {
    children.delete('openworker');
    console.error(`[gateway] openworker exited (${code ?? signal})`);
    if (!shuttingDown) setTimeout(startOpenWorker, 3000).unref();
  });
}

function startChild(name, cwd, port) {
  if (shuttingDown) return;
  const child = spawn(process.execPath, ['server.js'], { cwd, env: childEnvironment(name, port), stdio: ['ignore', 'pipe', 'pipe'] });
  children.set(name, child);
  child.stdout.on('data', chunk => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code, signal) => {
    children.delete(name);
    console.error(`[gateway] ${name} exited (${code ?? signal})`);
    if (!shuttingDown) setTimeout(() => startChild(name, cwd, port), 2000).unref();
  });
}

function proxy(req, res, { port, stripPrefix = '', targetPath: requestedTargetPath = '' }) {
  let targetPath = requestedTargetPath || req.url;
  if (stripPrefix && targetPath.startsWith(stripPrefix)) targetPath = targetPath.slice(stripPrefix.length) || '/';
  const headers = { ...req.headers, host: `127.0.0.1:${port}`, 'x-forwarded-host': req.headers.host || '', 'x-forwarded-proto': req.headers['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http') };
  if (stripPrefix) headers['x-forwarded-prefix'] = stripPrefix;
  delete headers.connection;
  const upstream = http.request({ hostname: '127.0.0.1', port, method: req.method, path: targetPath, headers }, upstreamResponse => {
    const responseHeaders = { ...upstreamResponse.headers };
    res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(res);
  });
  upstream.on('error', error => {
    if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '2' });
    res.end(JSON.stringify({ error: 'Service is starting', detail: error.message }));
  });
  req.pipe(upstream);
}

async function check(port, pathName) {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathName, timeout: 2000 }, response => { response.resume(); resolve(response.statusCode && response.statusCode < 500); });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

const gateway = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/gateway/health') {
    const [tona, teamflow, openworker] = await Promise.all([check(TONA_PORT, '/'), check(TEAMFLOW_PORT, '/api/health'), OPENWORKER_ENABLED && OPENWORKER_MODE !== 'remote' ? check(OPENWORKER_PORT, '/v1/health') : Promise.resolve(false)]);
    const ready = tona && teamflow && (!OPENWORKER_ENABLED || OPENWORKER_MODE === 'remote' || openworker);
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: ready, gateway: true, tona, teamflow, openworker: { enabled: OPENWORKER_ENABLED, mode: OPENWORKER_MODE, ready: openworker } }));
  }
  // TONA_HUB_ENTRY_GATE_V1: unauthenticated visitors always start at the Hub login page.
  const hasSession = /(?:^|;\s*)teamflow_session=/.test(String(req.headers.cookie || ''));
  const publicTeamflowPaths = new Set(['/teamflow/hub-login.html', '/teamflow/hub-login.js', '/teamflow/hub-login.css', '/teamflow/hub.css']);
  const publicTeamflowApi = pathname === '/teamflow/api/login' || pathname === '/teamflow/api/register' || pathname === '/teamflow/api/health';
  if (!hasSession && pathname === '/') return proxy(req, res, { port: TEAMFLOW_PORT, targetPath: '/hub-login.html' });
  if (!hasSession && (pathname === '/teamflow' || pathname === '/teamflow/' || (pathname.startsWith('/teamflow/') && !publicTeamflowPaths.has(pathname) && !publicTeamflowApi))) {
    res.writeHead(302, { Location: '/' }); return res.end();
  }
  if (pathname === '/teamflow') { res.writeHead(308, { Location: '/teamflow/' }); return res.end(); }
  if (pathname.startsWith('/teamflow/')) return proxy(req, res, { port: TEAMFLOW_PORT, stripPrefix: '/teamflow' });
  return proxy(req, res, { port: TONA_PORT });
});

startChild('tona', ROOT, TONA_PORT);
startChild('teamflow', path.join(ROOT, 'teamflow-lite'), TEAMFLOW_PORT);
startOpenWorker();

gateway.listen(PORT, '0.0.0.0', () => console.log(`[gateway] TONA at http://localhost:${PORT}/ and TeamFlow at http://localhost:${PORT}/teamflow/`));

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) child.kill('SIGTERM');
  gateway.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
