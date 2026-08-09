const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { WebSocketServer } = require("ws");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-openworker-api-"));
const tonaPort = 17441;
const workerPort = 17442;
const token = "openworker-api-test-token";
let child;

const sessions = new Map();
const workerHttp = http.createServer((req, res) => {
  if (req.headers["x-openworker-token"] !== token) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }
  const routes = {
    "/v1/health": { status: "ok", model: "test:worker" },
    "/v1/agents": { agents: [{ id: "cowork", name: "Cowork" }, { id: "code", name: "Code" }] },
    "/v1/sessions": { sessions: [] }
  };
  const pathname = new URL(req.url, "http://localhost").pathname;
  const body = routes[pathname] || (pathname.endsWith("/unattended") ? { ok: true } : { ok: true, items: [] });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
});

const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => protocols.has("openworker") ? "openworker" : false });
workerHttp.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});
wss.on("connection", (socket, request) => {
  const sessionId = decodeURIComponent(new URL(request.url, "http://localhost").pathname.split("/").at(-1));
  if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
  sessions.get(sessionId).add(socket);
  socket.on("close", () => sessions.get(sessionId)?.delete(socket));
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "interrupt") {
      for (const peer of sessions.get(sessionId) || []) peer.send(JSON.stringify({ type: "interrupted", data: {} }));
      return;
    }
    if (message.type !== "user_message") return;
    socket.send(JSON.stringify({ type: "tool_started", data: { name: "shell", arguments: { command: "npm test" } } }));
    if (message.text.includes("等待中断")) return;
    socket.send(JSON.stringify({ type: "tool_finished", data: { name: "shell", status: "completed", result_preview: "tests passed" } }));
    socket.send(JSON.stringify({ type: "assistant_message", data: { text: "OpenWorker API integration complete." } }));
    socket.send(JSON.stringify({ type: "turn_done", data: {} }));
  });
});

async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${tonaPort}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(check, message) {
  for (let index = 0; index < 80; index += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { console.log("LAST TASKS", JSON.stringify((await request("/api/assistant-tasks")).body)); } catch {}
  throw new Error(message);
}

(async () => {
  await new Promise((resolve) => workerHttp.listen(workerPort, "127.0.0.1", resolve));
  child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(tonaPort),
      DATA_DIR: dataDir,
      TONA_HUB_AUTH_REQUIRED: "false",
      TONA_SECRETS_KEY: "openworker-api-encryption-key",
      OPENWORKER_ENABLED: "true",
      OPENWORKER_MODE: "remote",
      OPENWORKER_URL: `http://127.0.0.1:${workerPort}`,
      OPENWORKER_API_TOKEN: token
    },
    stdio: "ignore"
  });

  try {
    await waitFor(async () => { try { return (await request("/api/health")).body.ok; } catch { return false; } }, "TONA did not start");
    const config = await request("/api/openworker");
    assert.equal(config.status, 200);
    assert.equal(config.body.ready, true);
    assert.notEqual(config.body.settings.apiToken, token);
    assert.equal(config.body.settings.tokenConfigured, true);
    assert(config.body.agents.some((agent) => agent.id === "code"));

    const submitted = await request("/api/openworker/run", { method: "POST", body: JSON.stringify({ prompt: "通过线上终端运行测试", workerAgent: "code" }) });
    assert.equal(submitted.status, 202);
    const completed = await waitFor(async () => (await request("/api/assistant-tasks")).body.tasks.find((task) => task.id === submitted.body.task.id && task.status === "completed"), "OpenWorker task did not complete");
    assert.equal(completed.output.summary, "OpenWorker API integration complete.");
    assert(completed.tools.some((tool) => tool.name === "shell" && tool.status === "completed"));

    const waiting = await request("/api/openworker/run", { method: "POST", body: JSON.stringify({ prompt: "等待中断", workerAgent: "code" }) });
    await waitFor(async () => (await request("/api/assistant-tasks")).body.tasks.find((task) => task.id === waiting.body.task.id && task.status === "running"), "OpenWorker task did not enter running state");
    const cancelled = await request(`/api/assistant-tasks/${waiting.body.task.id}/action`, { method: "POST", body: JSON.stringify({ action: "cancel" }) });
    assert.equal(cancelled.body.task.status, "cancelled");
    assert.equal(cancelled.body.task.output.checkpoint.stoppedAt, "interrupted");
    assert(cancelled.body.task.output.checkpoint.resumeHint.includes("继续执行"));

    const continued = await request(`/api/assistant-tasks/${waiting.body.task.id}/action`, { method: "POST", body: JSON.stringify({ action: "continue" }) });
    assert.equal(continued.status, 202);
    const resumed = await waitFor(async () => (await request("/api/assistant-tasks")).body.tasks.find((task) => task.id === waiting.body.task.id && task.status === "completed"), "Cancelled task did not resume");
    assert.equal(resumed.output.summary, "OpenWorker API integration complete.");

    console.log("OpenWorker API test passed: authenticated health, online terminal task, tool trace, interrupt checkpoint, and same-session continuation.");
  } finally {
    child?.kill();
    await new Promise((resolve) => workerHttp.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
