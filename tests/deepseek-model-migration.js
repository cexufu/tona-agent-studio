const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = 17371;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tona-deepseek-migration-test-'));
const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });

async function request(url, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status + ': ' + JSON.stringify(body));
  return body;
}
async function ready() {
  for (let i = 0; i < 30; i += 1) {
    try { return await request('/api/state'); } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('Server did not start');
}

(async () => {
  try {
    const state = await ready();
    const deepseek = state.providers.find((provider) => provider.id === 'deepseek');
    const daily = state.agents.find((agent) => agent.id === 'daily_assistant');
    await request('/api/providers', { method: 'POST', body: JSON.stringify({ ...deepseek, apiKey: 'test-key', enabled: true, defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] }) });
    const savedAgent = await request('/api/agents', { method: 'POST', body: JSON.stringify({ ...daily, providerId: 'deepseek', model: 'deepseek-chat' }) });
    if (savedAgent.agent.model !== 'deepseek-v4-pro') throw new Error('Retired DeepSeek model was not upgraded in agent save response');
    const migrated = await request('/api/state');
    const migratedDeepSeek = migrated.providers.find((provider) => provider.id === 'deepseek');
    const migratedDaily = migrated.agents.find((agent) => agent.id === 'daily_assistant');
    const retired = ['deepseek-chat', 'deepseek-reasoner'];
    if (migratedDeepSeek.defaultModel !== 'deepseek-v4-pro') throw new Error('Retired DeepSeek provider default was not migrated');
    if (!['deepseek-v4-pro', 'deepseek-v4-flash'].every((model) => migratedDeepSeek.models.includes(model))) throw new Error('Supported DeepSeek V4 models were not added');
    if (retired.some((model) => migratedDeepSeek.models.includes(model))) throw new Error('Retired DeepSeek models remain selectable');
    if (migratedDaily.model !== 'deepseek-v4-pro') throw new Error('Retired DeepSeek agent model was not migrated');
    console.log('DeepSeek migration test passed: retired model IDs upgrade to supported V4 defaults');
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
