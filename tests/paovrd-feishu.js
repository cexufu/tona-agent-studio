const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const tonaPort = 17466;
const fakePort = 17467;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-paovrd-feishu-"));
const modelCalls = [];
const deliveries = [];

function readJson(req) { return new Promise((resolve) => { let raw = ""; req.on("data", (chunk) => { raw += chunk; }); req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } }); }); }
function json(res, body) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
function modelAnswer(body) {
  const prompt = (body.messages || []).map((item) => item.content).join("\n");
  if (prompt.includes("Plan phase of TONA PAOVRD")) return JSON.stringify({ summary: "计算并核验结果", steps: ["调用数学工具", "核验结果"], completionCriteria: ["获得工具计算结果", "向用户交付结果"] });
  if (prompt.includes("Act phase of TONA PAOVRD")) {
    return prompt.includes('"toolId":"math_calculate"')
      ? JSON.stringify({ type: "finish", rationale: "已经获得确定性工具结果" })
      : JSON.stringify({ type: "tool", toolId: "math_calculate", input: { expression: "2+2" }, rationale: "使用确定性工具避免心算错误" });
  }
  if (prompt.includes("Verify phase of TONA PAOVRD")) return JSON.stringify({ passed: true, summary: "数学工具已返回结果 4", gaps: [], next: "deliver", question: "" });
  if (prompt.includes("Deliver phase of TONA PAOVRD")) return "2 + 2 = 4。结果已通过数学工具核验。";
  throw new Error("Unexpected model phase: " + prompt.slice(0, 200));
}
const fakeServices = http.createServer(async (req, res) => {
  const body = await readJson(req);
  if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") return json(res, { code: 0, tenant_access_token: "fake-token" });
  if (req.url === "/open-apis/chat/completions") {
    modelCalls.push(body);
    try { return json(res, { choices: [{ message: { content: modelAnswer(body) } }], usage: {} }); }
    catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: error.message } })); }
  }
  if (req.url.startsWith("/open-apis/im/v1/messages/")) { deliveries.push({ path: req.url, body }); return json(res, { code: 0, data: { message_id: "paovrd_reply" } }); }
  if (req.url.startsWith("/open-apis/im/v1/messages?")) { deliveries.push({ path: req.url, body }); return json(res, { code: 0, data: { message_id: "paovrd_active" } }); }
  return json(res, { code: 0, data: {} });
});
function start(server, port) { return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)); }
async function request(route, options = {}) { const response = await fetch(`http://127.0.0.1:${tonaPort}${route}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } }); const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`); return body; }
async function ready() { for (let index = 0; index < 50; index += 1) { try { return await request("/api/state"); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } throw new Error("Server did not start"); }
function storedDb() { return JSON.parse(fs.readFileSync(path.join(dataDir, "workspaces", "usr_owner", "studio.json"), "utf8")); }
async function waitFor(check, label) { for (let index = 0; index < 120; index += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Timed out waiting for " + label); }

(async () => {
  let child;
  try {
    await start(fakeServices, fakePort);
    child = spawn(process.execPath, ["server.js"], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, PORT: String(tonaPort), DATA_DIR: dataDir, FEISHU_OPEN_API_BASE: `http://127.0.0.1:${fakePort}/open-apis` }, stdio: ["ignore", "pipe", "pipe"] });
    const state = await ready();
    const agent = state.agents[0];
    await request("/api/providers", { method: "POST", body: JSON.stringify({ id: "paovrd-model", name: "PAOVRD model", type: "openai_compatible", baseUrl: `http://127.0.0.1:${fakePort}/open-apis`, apiKey: "fake-key", defaultModel: "fake-model", models: ["fake-model"], enabled: true }) });
    await request("/api/agents", { method: "POST", body: JSON.stringify({ ...agent, providerId: "paovrd-model", model: "fake-model" }) });
    await request("/api/lark-bots", { method: "POST", body: JSON.stringify({ name: "PAOVRDBot", appId: "cli_paovrd", appSecret: "fake-secret", agentId: agent.id, openId: "ou_paovrd_bot", enabled: true }) });
    const event = { header: { event_type: "im.message.receive_v1", app_id: "cli_paovrd" }, event: { sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } }, message: { message_id: "paovrd_message", chat_id: "chat_paovrd", chat_type: "group", message_type: "text", mentions: [{ name: "PAOVRDBot", id: { open_id: "ou_paovrd_bot" } }], content: JSON.stringify({ text: "@_user_1 请计算 2+2，并使用工具核验结果" }) } } };
    await request("/feishu/events/usr_owner", { method: "POST", body: JSON.stringify(event) });
    await waitFor(() => (storedDb().settings.assistantTasks || []).some((item) => item.type === "paovrd" && ["completed", "failed", "waiting_input", "waiting_confirmation", "completed_with_limits"].includes(item.status)), "PAOVRD completion");
    const task = (storedDb().settings.assistantTasks || []).find((item) => item.type === "paovrd");
    if (!task || task.status !== "completed") throw new Error("PAOVRD task did not complete: " + JSON.stringify(task?.status));
    if (!task.observations.some((item) => item.toolId === "math_calculate" && item.status === "success" && String(item.data).includes("4"))) throw new Error("PAOVRD did not persist the successful math observation");
    for (const phase of ["plan", "act", "observe", "verify", "deliver"]) if (!task.trace.some((item) => item.phase === phase)) throw new Error("Missing PAOVRD trace phase: " + phase);
    if (modelCalls.length !== 5) throw new Error("Expected five bounded model calls, got " + modelCalls.length);
    await waitFor(() => deliveries.length > 0, "final Feishu reply");
    if (deliveries.length !== 1 || deliveries[0].body.msg_type !== "post" || !deliveries[0].body.content.includes("2 + 2 = 4")) throw new Error("Final verified result was not replied to Feishu: " + JSON.stringify(deliveries));
    console.log("PAOVRD Feishu integration test passed: event routing, plan-act-observe-verify-deliver, deterministic tool evidence, persistence, and verified reply.");
  } finally {
    if (child) child.kill();
    await new Promise((resolve) => fakeServices.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
