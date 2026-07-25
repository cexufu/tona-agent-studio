const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tonaPort = 17374;
const feishuPort = 17375;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tona-document-tools-'));
const calls = [];
let tableCells = [];

function readJson(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { resolve({}); } });
  });
}
function json(res, body) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
const fakeFeishu = http.createServer(async (req, res) => {
  const body = await readJson(req);
  calls.push({ method: req.method, path: req.url, body });
  if (req.url === '/open-apis/auth/v3/tenant_access_token/internal') return json(res, { code: 0, tenant_access_token: 'fake-token' });
  if (req.url === '/open-apis/chat/completions' && req.method === 'POST') return json(res, { choices: [{ message: { content: '# \u672c\u5468\u79d1\u7814\u8ba1\u5212\n\n## \u6838\u5fc3\u4efb\u52a1\n\n- \u5b8c\u6210\u6570\u636e\u5206\u6790\n- \u63a8\u8fdb\u8bba\u6587\u521d\u7a3f\n\n## \u65f6\u95f4\u5b89\u6392\n\n| \u4efb\u52a1 | \u622a\u6b62\u65f6\u95f4 |\n| --- | --- |\n| \u6570\u636e\u6e05\u6d17 | \u5468\u4e09 |\n| \u521d\u7a3f | \u5468\u4e94 |' } }], usage: {} });
  if (req.url === '/open-apis/docx/v1/documents' && req.method === 'POST') return json(res, { code: 0, data: { document: { document_id: 'doc_created_123' } } });
  if (req.url === '/open-apis/docx/v1/documents/doc_created_123/blocks/doc_created_123/children' && req.method === 'POST') { const table = (body.children || []).find((child) => child.block_type === 31); if (table) { const size = table.table.property.row_size * table.table.property.column_size; tableCells = Array.from({ length: size }, (_, index) => 'cell_' + index); return json(res, { code: 0, data: { children: [{ block_id: 'table_created_123' }] } }); } return json(res, { code: 0, data: { children: body.children || [] } }); }
  if (req.url === '/open-apis/docx/v1/documents/doc_created_123/blocks/table_created_123' && req.method === 'GET') return json(res, { code: 0, data: { block: { table: { cells: tableCells } } } });
  if (/^\/open-apis\/docx\/v1\/documents\/doc_created_123\/blocks\/cell_\d+\/children\?page_size=1$/.test(req.url) && req.method === 'GET') { const cellId = req.url.match(/blocks\/(cell_\d+)/)[1]; return json(res, { code: 0, data: { items: [{ block_id: 'text_' + cellId }] } }); }
  if (/^\/open-apis\/docx\/v1\/documents\/doc_created_123\/blocks\/text_cell_\d+$/.test(req.url) && req.method === 'PATCH') return json(res, { code: 0, data: {} });
  if (req.url === '/open-apis/docx/v1/documents/doc_source_123/blocks?page_size=200' && req.method === 'GET') return json(res, { code: 0, data: { items: [{ text: { elements: [{ text_run: { content: 'Source research note' } }] } }] } });
  if (req.url.startsWith('/open-apis/im/v1/messages/') || req.url.startsWith('/open-apis/im/v1/messages?')) return json(res, { code: 0, data: { message_id: 'message_' + calls.length } });
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 404, msg: 'not found' }));
});
function start(server, port) { return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)); }
async function request(url, options = {}) {
  const response = await fetch('http://127.0.0.1:' + tonaPort + url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status + ': ' + JSON.stringify(body));
  return body;
}
async function ready() {
  for (let i = 0; i < 40; i += 1) { try { return await request('/api/state'); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } }
  throw new Error('Server did not start');
}
function storedDb() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'workspaces', 'usr_owner', 'studio.json'), 'utf8')); }
async function waitFor(check, label) {
  for (let i = 0; i < 80; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for ' + label);
}
function messageEvent(messageId, text) {
  return { header: { event_type: 'im.message.receive_v1', app_id: 'cli_doc_tools' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_requester' } }, message: { message_id: messageId, chat_id: 'chat_doc_tools', chat_type: 'group', message_type: 'text', mentions: [{ name: 'DocBot', id: { open_id: 'ou_doc_bot' } }], content: JSON.stringify({ text }) } } };
}

(async () => {
  let child;
  try {
    await start(fakeFeishu, feishuPort);
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(tonaPort), DATA_DIR: dataDir, FEISHU_OPEN_API_BASE: 'http://127.0.0.1:' + feishuPort + '/open-apis' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = await ready();
    await request('/api/providers', { method: 'POST', body: JSON.stringify({ id: 'deepseek', name: 'Fake model', type: 'openai_compatible', baseUrl: 'http://127.0.0.1:' + feishuPort + '/open-apis', apiKey: 'fake-key', defaultModel: 'fake-model', models: ['fake-model'], enabled: true }) });
    await request('/api/lark-bots', { method: 'POST', body: JSON.stringify({ name: 'DocBot', appId: 'cli_doc_tools', appSecret: 'secret_doc', agentId: state.agents[0].id, openId: 'ou_doc_bot', enabled: true }) });

    await request('/feishu/events/usr_owner', { method: 'POST', body: JSON.stringify(messageEvent('doc_create_message', '@_user_1 \u751f\u6210\u98de\u4e66\u6587\u6863\uff1a\u65b0\u7814\u7a76\u8ba1\u5212')) });
    await waitFor(() => calls.some((call) => call.path.includes('/im/v1/messages/doc_create_message/reply')), 'document request card');
    const cardCall = calls.find((call) => call.path.includes('/im/v1/messages/doc_create_message/reply'));
    const card = JSON.parse(cardCall.body.content);
    const confirm = card.elements.find((item) => item.tag === 'action').actions.find((action) => action.value.action === 'approve');
    if (confirm.value.source !== 'tona_document_delivery') throw new Error('Document confirmation card was not sent');
    let db = storedDb();
    const documentRequest = (db.settings.documentRequests || []).find((item) => item.id === confirm.value.requestId);
    if (!documentRequest || documentRequest.status !== 'pending') throw new Error('Document request was not stored privately');
    const publicState = await request('/api/state');
    if (publicState.settings.documentRequests !== undefined) throw new Error('Document request ledger was exposed in public state');

    if (confirm.value.workspaceId !== 'usr_owner' || confirm.value.botAppId !== 'cli_doc_tools') throw new Error('Document card did not retain its source workspace and bot');
    const callback = await request('/feishu/events/usr_other', { method: 'POST', body: JSON.stringify({ header: { event_type: 'card.action.trigger_v1', app_id: 'cli_doc_tools' }, event: { operator: { open_id: 'ou_requester' }, action: { value: confirm.value } } }) });
    if (callback.toast?.type !== 'success') throw new Error('Document approval callback was not accepted');
    await waitFor(() => (storedDb().settings.documentRequests || []).some((item) => item.id === confirm.value.requestId && ['completed', 'failed'].includes(item.status)), 'document delivery');
    const deliveredRequest = (storedDb().settings.documentRequests || []).find((item) => item.id === confirm.value.requestId);
    if (deliveredRequest.status !== 'completed') throw new Error('Document delivery failed: ' + deliveredRequest.error);
    if (!calls.some((call) => call.path === '/open-apis/docx/v1/documents' && call.method === 'POST')) throw new Error('Feishu document was not created');
    const writeCall = calls.find((call) => call.path.includes('/blocks/doc_created_123/children'));
    if (!writeCall?.body.children?.length) throw new Error('Generated content was not written to Feishu document blocks');
    if (!calls.some((call) => call.path === '/open-apis/docx/v1/documents/doc_created_123/blocks/doc_created_123/children' && call.body.children?.some((child) => child.block_type === 31))) throw new Error('Markdown table was not created as a native Feishu table');
    if (calls.filter((call) => /^\/open-apis\/docx\/v1\/documents\/doc_created_123\/blocks\/text_cell_\d+$/.test(call.path) && call.method === 'PATCH').length !== 6) throw new Error('Native table cells were not populated');
    if (!writeCall?.body.children?.some((child) => child.block_type === 3 && child.heading1)) throw new Error('Markdown heading was not rendered as a native Feishu heading');
    const resultCall = calls.find((call) => call.path.startsWith('/open-apis/im/v1/messages?receive_id_type=chat_id'));
    if (!resultCall || !JSON.parse(resultCall.body.content).elements[0].text.content.includes('https://feishu.cn/docx/doc_created_123')) throw new Error('Document result card was not returned to the originating chat');

    await request('/feishu/events/usr_owner', { method: 'POST', body: JSON.stringify(messageEvent('doc_read_message', '@_user_1 \u8bfb\u53d6\u98de\u4e66\u6587\u6863 https://feishu.cn/docx/doc_source_123 \u5e76\u603b\u7ed3')) });
    await waitFor(() => calls.some((call) => call.path === '/open-apis/docx/v1/documents/doc_source_123/blocks?page_size=200'), 'specified document read');
    console.log('Feishu document tools test passed: request card, requester approval, document create/write/result callback, and specified document read.');
  } finally {
    if (child) child.kill();
    await new Promise((resolve) => fakeFeishu.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
