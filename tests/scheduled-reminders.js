const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const tonaPort = 17426;
const feishuPort = 17427;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-scheduled-reminder-"));
const deliveries = [];

function readJson(req) { return new Promise((resolve) => { let raw = ""; req.on("data", (chunk) => { raw += chunk; }); req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } }); }); }
function json(res, body) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
const fakeFeishu = http.createServer(async (req, res) => {
  const body = await readJson(req);
  if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") return json(res, { code: 0, tenant_access_token: "fake-token" });
  if (req.url.startsWith("/open-apis/im/v1/messages/")) { deliveries.push({ kind: "reply", path: req.url, body }); return json(res, { code: 0, data: { message_id: "reply" } }); }
  if (req.url.startsWith("/open-apis/im/v1/messages?")) { deliveries.push({ kind: "proactive", path: req.url, body }); return json(res, { code: 0, data: { message_id: "proactive" } }); }
  return json(res, { code: 0, data: {} });
});
function start(server, port) { return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)); }
async function request(url, options = {}) { const response = await fetch("http://127.0.0.1:" + tonaPort + url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } }); const body = await response.json(); if (!response.ok) throw new Error(response.status + ": " + JSON.stringify(body)); return body; }
async function ready() { for (let i = 0; i < 60; i += 1) { try { return await request("/api/state"); } catch { await new Promise((resolve) => setTimeout(resolve, 80)); } } throw new Error("Server did not start"); }
function storedDb() { return JSON.parse(fs.readFileSync(path.join(dataDir, "workspaces", "usr_owner", "studio.json"), "utf8")); }
async function waitFor(check, label, attempts = 120) { for (let i = 0; i < attempts; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Timed out: " + label); }

(async () => {
  let child;
  try {
    await start(fakeFeishu, feishuPort);
    child = spawn(process.execPath, ["server.js"], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, PORT: String(tonaPort), DATA_DIR: dataDir, FEISHU_OPEN_API_BASE: "http://127.0.0.1:" + feishuPort + "/open-apis", ASSISTANT_SCHEDULER_INTERVAL_MS: "1000" }, stdio: ["ignore", "pipe", "pipe"] });
    const state = await ready(); const agent = state.agents[0];
    await request("/api/lark-bots", { method: "POST", body: JSON.stringify({ name: "ReminderBot", appId: "cli_reminder", appSecret: "secret", agentId: agent.id, openId: "ou_reminder_bot", enabled: true }) });
    const event = { header: { event_type: "im.message.receive_v1", app_id: "cli_reminder" }, event: { sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } }, message: { message_id: "reminder_message", chat_id: "chat_reminder", chat_type: "group", message_type: "text", mentions: [{ name: "ReminderBot", id: { open_id: "ou_reminder_bot" } }], content: JSON.stringify({ text: "@_user_1 6秒后提醒我检查实验结果" }) } } };
    await request("/feishu/events/usr_owner", { method: "POST", body: JSON.stringify(event) });
    await waitFor(() => deliveries.some((item) => item.kind === "reply"), "reminder confirmation card");
    const card = JSON.parse(deliveries.find((item) => item.kind === "reply").body.content);
    const approve = card.elements.find((item) => item.tag === "action").actions.find((item) => item.value.action === "approve");
    if (approve.value.source !== "tona_scheduled_reminder") throw new Error("Reminder did not use the scheduler confirmation card");
    let db = storedDb(); const task = (db.settings.assistantTasks || []).find((item) => item.id === approve.value.taskId);
    if (!task || task.status !== "pending_confirmation") throw new Error("Reminder was not stored before confirmation");
    await request("/feishu/events/usr_owner", { method: "POST", body: JSON.stringify({ header: { event_type: "card.action.trigger_v1", app_id: "cli_reminder" }, event: { operator: { open_id: "ou_owner" }, action: { value: approve.value } } }) });
    await waitFor(() => deliveries.some((item) => item.kind === "proactive"), "proactive reminder delivery");
    db = storedDb(); const sent = (db.settings.assistantTasks || []).find((item) => item.id === task.id);
    if (sent.status !== "sent" || !sent.sentAt) throw new Error("Reminder was not marked sent");
    if (deliveries.filter((item) => item.kind === "proactive").length !== 1) throw new Error("Reminder was delivered more than once");
    const post = JSON.parse(deliveries.find((item) => item.kind === "proactive").body.content);
    const mention = (post.zh_cn?.content || []).flat().find((item) => item.tag === "at");
    if (!mention || mention.user_id !== "ou_owner") throw new Error("Reminder did not @ the requester");
    console.log("Scheduled reminder test passed: confirmation, persistence, proactive delivery, requester mention, and no duplicate send.");
  } finally { if (child) child.kill(); await new Promise((resolve) => fakeFeishu.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
