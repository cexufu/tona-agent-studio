const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tonaPort = 17376;
const feishuPort = 17377;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tona-calendar-plan-'));
const calls = [];

function readJson(req) { return new Promise((resolve) => { let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } }); }); }
function json(res, body) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
const fakeFeishu = http.createServer(async (req, res) => {
  const body = await readJson(req); calls.push({ method: req.method, path: req.url, body });
  if (req.url === '/open-apis/auth/v3/tenant_access_token/internal') return json(res, { code: 0, tenant_access_token: 'fake-token' });
  if (req.url.startsWith('/open-apis/im/v1/messages/')) return json(res, { code: 0, data: { message_id: 'reply' } });
  if (req.url.startsWith('/open-apis/im/v1/messages?')) return json(res, { code: 0, data: { message_id: 'post' } });
  return json(res, { code: 0, data: {} });
});
function start(server, port) { return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)); }
async function request(url, options = {}) { const response = await fetch('http://127.0.0.1:' + tonaPort + url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }); const body = await response.json(); if (!response.ok) throw new Error(response.status + ': ' + JSON.stringify(body)); return body; }
async function ready() { for (let i = 0; i < 40; i += 1) { try { return await request('/api/state'); } catch { await new Promise((resolve) => setTimeout(resolve, 80)); } } throw new Error('Server did not start'); }
function storedDb() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'workspaces', 'usr_owner', 'studio.json'), 'utf8')); }
async function waitFor(check, label) { for (let i = 0; i < 40; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error('Timed out: ' + label); }

(async () => {
  let child;
  try {
    await start(fakeFeishu, feishuPort);
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(tonaPort), DATA_DIR: dataDir, FEISHU_OPEN_API_BASE: 'http://127.0.0.1:' + feishuPort + '/open-apis' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = await ready();
    await request('/api/providers', { method: 'POST', body: JSON.stringify({ id: 'deepseek', name: 'Fake', type: 'openai_compatible', baseUrl: 'http://example.invalid', apiKey: 'fake', defaultModel: 'fake', models: ['fake'], enabled: true }) });
    await request('/api/lark-bots', { method: 'POST', body: JSON.stringify({ name: 'CalendarBot', appId: 'cli_calendar', appSecret: 'secret', agentId: state.agents[0].id, openId: 'ou_calendar_bot', enabled: true }) });
    const event = { header: { event_type: 'im.message.receive_v1', app_id: 'cli_calendar' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { message_id: 'calendar_message', chat_id: 'chat_calendar', chat_type: 'group', message_type: 'text', mentions: [{ name: 'CalendarBot', id: { open_id: 'ou_calendar_bot' } }], content: JSON.stringify({ text: '@_user_1 \u5b89\u6392\u4f1a\u8bae\uff1a\u4e0b\u5468\u548c\u5bfc\u5e08\u8ba8\u8bba\u5b9e\u9a8c\u8bbe\u8ba1' }) } } };
    await request('/feishu/events/usr_owner', { method: 'POST', body: JSON.stringify(event) });
    await waitFor(() => calls.some((call) => call.path.includes('/im/v1/messages/calendar_message/reply')), 'calendar confirmation card');
    const cardCall = calls.find((call) => call.path.includes('/im/v1/messages/calendar_message/reply'));
    const card = JSON.parse(cardCall.body.content);
    const approve = card.elements.find((item) => item.tag === 'action').actions.find((item) => item.value.action === 'approve');
    if (approve.value.source !== 'tona_calendar_plan') throw new Error('Calendar request did not use a confirmation card');
    let db = storedDb(); const task = (db.settings.assistantTasks || []).find((item) => item.id === approve.value.taskId);
    if (!task || task.status !== 'pending_confirmation') throw new Error('Calendar task was not stored as pending confirmation');
    const publicState = await request('/api/state'); if (publicState.settings.assistantTasks !== undefined) throw new Error('Assistant tasks leaked through public state');
    const callback = await request('/feishu/events/usr_owner', { method: 'POST', body: JSON.stringify({ header: { event_type: 'card.action.trigger_v1', app_id: 'cli_calendar' }, event: { operator: { open_id: 'ou_owner' }, action: { value: approve.value } } }) });
    if (callback.toast?.type !== 'success') throw new Error('Calendar confirmation was not accepted');
    await waitFor(() => (storedDb().settings.assistantTasks || []).some((item) => item.id === task.id && item.status === 'awaiting_calendar_oauth'), 'calendar task status');
    if (calls.some((call) => call.path.includes('/calendar/'))) throw new Error('Calendar API was called before user OAuth was configured');
    console.log('Calendar planning test passed: confirmation card, private task ledger, health status, and no calendar write before OAuth.');
  } finally { if (child) child.kill(); await new Promise((resolve) => fakeFeishu.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
