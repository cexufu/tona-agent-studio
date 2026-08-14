const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 17360;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamflow-test-'));
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, INITIAL_ADMIN_PASSWORD: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let cookie = '';
const request = async (url, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { ...options, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) } });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
};

async function waitUntilReady() {
  for (let i = 0; i < 30; i += 1) {
    try { await request('/api/health'); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('Server did not become ready');
}

(async () => {
  try {
    await waitUntilReady();
    await request('/api/login', { method: 'POST', body: JSON.stringify({ email: 'admin@team.local', password: 'test-password' }) });
    const me = await request('/api/me');
    if (me.user.role !== 'owner') throw new Error('Expected owner role');
    const created = await request('/api/requirements', { method: 'POST', body: JSON.stringify({ title: '冒烟测试需求', summary: '验证完整需求链路', priority: 'P1', type: 'feature', targetDate: '2030-01-01' }) });
    const decomposition = await request(`/api/requirements/${created.requirement.id}/decompose`, { method: 'POST' });
    if (decomposition.tasks.length !== 4) throw new Error('Expected four decomposed tasks');
    await request(`/api/tasks/${decomposition.tasks[0].id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    const dashboard = await request('/api/dashboard');
    if (!dashboard.stats || dashboard.stats.teamMembers !== 1) throw new Error('Dashboard stats are invalid');
    console.log('Smoke test passed: login, requirement, decomposition, task update, dashboard');
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
