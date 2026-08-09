const assert = require("assert");
const { EventEmitter } = require("events");
const { normalizeOpenWorkerSettings, publicOpenWorkerSettings, OpenWorkerClient } = require("../runtime/openworker-client");
const { createOpenWorkerTask, executeOpenWorkerTask, publicOpenWorkerTask } = require("../runtime/openworker-integration");

class FakeSocket extends EventEmitter {
  constructor(url, protocols) {
    super(); this.url = url; this.protocols = protocols; this.sent = [];
    setImmediate(() => this.emit("open"));
  }
  send(value) {
    const message = JSON.parse(value); this.sent.push(message);
    if (message.type !== "user_message") return;
    setImmediate(() => {
      this.emit("message", JSON.stringify({ type: "tool_started", data: { name: "todo_write", arguments: { todos: [{ content: "检查项目", status: "in_progress" }] } } }));
      this.emit("message", JSON.stringify({ type: "tool_finished", data: { name: "todo_write", status: "completed", result_preview: "1 todo" } }));
      this.emit("message", JSON.stringify({ type: "assistant_message", data: { text: "已完成 OpenWorker 任务。", usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 } } }));
      this.emit("message", JSON.stringify({ type: "turn_done", data: {} }));
    });
  }
  close() {}
  terminate() {}
}

function fakeFetch(calls) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    let data = { ok: true };
    if (String(url).endsWith("/v1/health")) data = { status: "ok", model: "openai:gpt-test" };
    if (String(url).includes("/v1/skills") && (!options.method || options.method === "GET")) data = { skills: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
}

(async () => {
  const settings = normalizeOpenWorkerSettings({ baseUrl: "http://127.0.0.1:8765/", apiToken: "secret", defaultMode: "plan" }, {});
  assert.equal(settings.baseUrl, "http://127.0.0.1:8765");
  assert.equal(settings.defaultMode, "plan");
  assert.equal(settings.syncProviders, true);
  assert.equal(normalizeOpenWorkerSettings({ deployment: "remote" }, {}).syncProviders, false);
  assert.equal(publicOpenWorkerSettings(settings, () => "***").apiToken, "***");

  const calls = [];
  const client = new OpenWorkerClient(settings, { env: {}, fetch: fakeFetch(calls), WebSocket: FakeSocket });
  assert.equal((await client.health()).status, "ok");
  const providerSync = await client.syncProvider({ id: "deepseek", apiKey: "provider-secret", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-pro" });
  assert.equal(providerSync.model, "deepseek:deepseek-v4-pro");
  assert(calls.some((item) => item.url.endsWith("/v1/providers") && item.options.body.includes("provider-secret")));
  const synced = await client.syncSkill({ id: "research_brief", name: "研究简报", description: "整理研究材料", inputGuide: "提供材料", steps: [{ task: "核验事实" }], outputContract: "可审阅简报", qualityChecklist: ["标明来源"] });
  assert.equal(synced.ok, true);
  assert(calls.some((item) => item.options.method === "POST" && item.url.endsWith("/v1/skills")));

  const outcome = await client.runTurn({ sessionId: "tona_test", text: "检查项目", agent: "code", mode: "interactive" });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.message, "已完成 OpenWorker 任务。");
  assert.equal(outcome.tools[0].status, "completed");

  const task = createOpenWorkerTask({ goal: "运行测试", workspaceId: "ws", agentId: "coding", workerAgent: "code" });
  const persisted = [];
  const integrated = await executeOpenWorkerTask(task, { settings, env: {}, fetch: fakeFetch([]), WebSocket: FakeSocket, persist: (value) => persisted.push(value.status) });
  assert.equal(integrated.status, "completed");
  assert.equal(publicOpenWorkerTask(task).sessionId, task.sessionId);
  assert(persisted.includes("running") && persisted.includes("completed"));

  console.log("OpenWorker compatibility test passed: settings, auth, Skill sync, WebSocket events, task mapping, Todo/tool progress, and delivery.");
})().catch((error) => { console.error(error); process.exit(1); });
