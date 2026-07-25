const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = 17369;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tona-collaboration-test-'));
const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });

async function request(url, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status + ': ' + JSON.stringify(body));
  return body;
}
async function readJsonEventually(filePath) {
  let lastError;
  for (let index = 0; index < 30; index += 1) {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
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
    const allIds = state.agents.map(agent => agent.id);
    const policy = await request('/api/collaboration-policy', { method: 'POST', body: JSON.stringify({
      enabled: true,
      coordinatorAgentId: allIds[0],
      writerAgentId: allIds[allIds.length - 1],
      participantAgentIds: allIds,
      maxMessages: 999,
      decisionMakerOpenIds: 'ou_test_one, ou_test_two',
      requireCollaborationKeyword: true,
      allowBotHandoffs: true,
      requireWriteConfirmation: true
    }) });
    if (policy.collaborationPolicy.participantAgentIds.length !== 5) throw new Error('Participant limit was not enforced');
    if (policy.collaborationPolicy.maxMessages !== 10) throw new Error('Message limit was not fixed at 10');
    if (policy.collaborationPolicy.decisionMakerOpenIds.length !== 2) throw new Error('Decision-maker IDs were not normalized');
    const publicState = await request('/api/state');
    if (publicState.settings.collaborationTasks !== undefined) throw new Error('Internal collaboration task ledger was exposed');
    const selectedIds = allIds.slice(0, 3);
    const selectedAgents = selectedIds.map((id) => state.agents.find((agent) => agent.id === id));
    await request('/api/lark-bots', { method: 'POST', body: JSON.stringify({ name: 'test coordinator', appId: 'cli_test_coordinator', appSecret: '', agentId: selectedIds[0], openId: 'ou_test_coordinator', enabled: true }) });
    await request('/api/lark-bots', { method: 'POST', body: JSON.stringify({ name: 'test bystander', appId: 'cli_test_bystander', appSecret: '', agentId: selectedIds[1], openId: 'ou_test_bystander', enabled: true }) });
    await request('/feishu/events/usr_owner', { method: 'POST', body: JSON.stringify({
      header: { event_type: 'im.message.receive_v1', app_id: 'cli_test_coordinator' },
      event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_test_one' } }, message: { message_id: 'message_background_knowledge', chat_id: 'chat_dynamic_plan', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'Background decision: use the existing API contract.' }) } }
    }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    let memoryStored = await readJsonEventually(path.join(dataDir, 'workspaces', 'usr_owner', 'studio.json'));
    if (!(memoryStored.settings.groupKnowledge || []).some((item) => item.messageId === 'message_background_knowledge')) throw new Error('Unmentioned group message was not stored as group knowledge');
    if ((memoryStored.settings.collaborationTasks || []).length) throw new Error('Unmentioned group message should not start a task or reply');
    const taskText = "@_user_1 \u534f\u4f5c\u4efb\u52a1\uff1a\u534f\u8c03\uff1a" + selectedAgents[0].name + "\uff1b\u53c2\u4e0e\uff1a" + selectedAgents.map((agent) => agent.name).join("\u3001") + "\uff1b\u6267\u7b14\uff1a" + selectedAgents[2].name + "\uff1b\u8f6e\u6b21\uff1a10\uff1b\u4efb\u52a1\uff1a\u6d4b\u8bd5\u4e34\u65f6\u7f16\u7ec4";
    await request('/feishu/events/usr_owner', { method: 'POST', body: JSON.stringify({
      header: { event_type: 'im.message.receive_v1', app_id: 'cli_test_bystander' },
      event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_test_one' } }, message: { message_id: 'message_wrong_mention', chat_id: 'chat_dynamic_plan', chat_type: 'group', message_type: 'text', mentions: [{ key: '@_user_1', name: 'Feishu display name', id: { open_id: 'ou_test_coordinator' } }], content: JSON.stringify({ text: taskText }) } }
    }) });
    await new Promise((resolve) => setTimeout(resolve, 80));
    let stored = await readJsonEventually(path.join(dataDir, 'workspaces', 'usr_owner', 'studio.json'));
    if ((stored.settings.collaborationTasks || []).some((item) => item.sourceMessageId === 'message_wrong_mention')) throw new Error('Unmentioned bot started a group task');
    await request('/feishu/events/usr_owner', { method: 'POST', body: JSON.stringify({
      header: { event_type: 'im.message.receive_v1', app_id: 'cli_test_coordinator' },
      event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_test_one' } }, message: { message_id: 'message_dynamic_plan', chat_id: 'chat_dynamic_plan', chat_type: 'group', message_type: 'text', mentions: [{ key: '@_user_1', name: 'Feishu display name', id: { open_id: 'ou_test_coordinator' } }], content: JSON.stringify({ text: taskText }) } }
    }) });
    await new Promise((resolve) => setTimeout(resolve, 120));
    stored = await readJsonEventually(path.join(dataDir, 'workspaces', 'usr_owner', 'studio.json'));
    const task = (stored.settings.collaborationTasks || []).find((item) => item.sourceMessageId === 'message_dynamic_plan');
    if (!task) throw new Error('Feishu task directive did not create a collaboration task');
    if (task.coordinatorAgentId !== selectedIds[0] || task.writerAgentId !== selectedIds[2]) throw new Error('Coordinator or writer was not parsed from Feishu task directive');
    if (task.participantAgentIds.length !== 3 || task.rounds !== 10) throw new Error('Participants or rounds were not parsed from Feishu task directive');
    if (task.sequence.length !== 10 || task.sequence.at(-1) !== selectedIds[2]) throw new Error('Feishu task directive did not create a controlled sequence');
    const openDiscussionText = "@_user_1 协作任务：协调：" + selectedAgents[0].name + "；参与：" + selectedAgents.map((agent) => agent.name).join("、") + "；执笔：" + selectedAgents[2].name + "；任务：测试默认自由讨论";
    await request('/feishu/events/usr_owner', { method: 'POST', body: JSON.stringify({
      header: { event_type: 'im.message.receive_v1', app_id: 'cli_test_coordinator' },
      event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_test_one' } }, message: { message_id: 'message_open_discussion', chat_id: 'chat_dynamic_plan', chat_type: 'group', message_type: 'text', mentions: [{ key: '@_user_1', name: 'Feishu display name', id: { open_id: 'ou_test_coordinator' } }], content: JSON.stringify({ text: openDiscussionText }) } }
    }) });
    await new Promise((resolve) => setTimeout(resolve, 80));
    stored = await readJsonEventually(path.join(dataDir, 'workspaces', 'usr_owner', 'studio.json'));
    const openTask = (stored.settings.collaborationTasks || []).find((item) => item.sourceMessageId === 'message_open_discussion');
    if (!openTask || openTask.rounds !== 3 || openTask.sequence.length !== 10 || openTask.sequence.at(-1) !== selectedIds[2]) throw new Error('An unspecified round count did not create the balanced open discussion');
    if (!openTask.sequence.slice(0, -1).includes(selectedIds[2])) throw new Error('The final writer was excluded from the open discussion');
    const naturalRequestText = "@_user_1 请科研助理和" + selectedAgents[2].name + "一起分析这个项目的研究设计";
    await request('/feishu/events/usr_owner', { method: 'POST', body: JSON.stringify({
      header: { event_type: 'im.message.receive_v1', app_id: 'cli_test_coordinator' },
      event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_test_one' } }, message: { message_id: 'message_named_colleagues', chat_id: 'chat_dynamic_plan', chat_type: 'group', message_type: 'text', mentions: [{ key: '@_user_1', name: 'Feishu display name', id: { open_id: 'ou_test_coordinator' } }], content: JSON.stringify({ text: naturalRequestText }) } }
    }) });
    await new Promise((resolve) => setTimeout(resolve, 80));
    stored = await readJsonEventually(path.join(dataDir, 'workspaces', 'usr_owner', 'studio.json'));
    if (!(stored.settings.collaborationTasks || []).some((item) => item.sourceMessageId === 'message_named_colleagues')) throw new Error('Named colleague request did not start a controlled collaboration');
    console.log('Collaboration policy test passed: five-role cap, ten-message cap, private task ledger, natural named-colleague requests, Feishu task directives, open discussion defaults, exact open-id mention routing, and silent group knowledge capture');
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
