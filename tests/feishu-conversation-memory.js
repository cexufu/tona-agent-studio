const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const tonaPort = 17441;
const fakePort = 17442;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-conversation-memory-"));
const modelCalls = [];
let replyCount = 0;

function readJson(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => { try { resolve(JSON.parse(text || "{}")); } catch { resolve({}); } });
  });
}
function json(res, body) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
const fakeServices = http.createServer(async (req, res) => {
  const body = await readJson(req);
  if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") return json(res, { code: 0, tenant_access_token: "fake-token" });
  if (req.url === "/open-apis/chat/completions") {
    modelCalls.push(body);
    const content = modelCalls.length === 1 ? "Rules are complete and ready for confirmation." : "Confirmed. I will notify the team.";
    return json(res, { choices: [{ message: { content } }], usage: {} });
  }
  if (req.url.startsWith("/open-apis/im/v1/messages/") && req.url.endsWith("/reply")) {
    replyCount += 1;
    return json(res, { code: 0, data: { message_id: `bot_reply_${replyCount}` } });
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 404, msg: "not found" }));
});
function start(server, port) { return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)); }
async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${tonaPort}${route}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}
async function ready() {
  for (let index = 0; index < 40; index += 1) {
    try { return await request("/api/state"); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("Server did not start.");
}
async function waitFor(check, label) {
  for (let index = 0; index < 80; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function event(messageId, text, parentId = "") {
  return {
    header: { event_type: "im.message.receive_v1", app_id: "cli_memory" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
      message: {
        message_id: messageId,
        parent_id: parentId,
        root_id: parentId ? "user_message_1" : "",
        chat_id: "chat_memory",
        chat_type: "group",
        message_type: "text",
        mentions: [{ name: "MemoryBot", id: { open_id: "ou_memory_bot" } }],
        content: JSON.stringify({ text })
      }
    }
  };
}

(async () => {
  let child;
  try {
    await start(fakeServices, fakePort);
    child = spawn(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, PORT: String(tonaPort), DATA_DIR: dataDir, FEISHU_OPEN_API_BASE: `http://127.0.0.1:${fakePort}/open-apis` },
      stdio: "ignore"
    });
    const state = await ready();
    await request("/api/providers", { method: "POST", body: JSON.stringify({ id: "memory-model", name: "Memory model", type: "openai_compatible", baseUrl: `http://127.0.0.1:${fakePort}/open-apis`, apiKey: "fake-key", defaultModel: "fake-model", models: ["fake-model"], enabled: true }) });
    const agentId = state.agents[0].id;
    await request("/api/agents", { method: "POST", body: JSON.stringify({ ...state.agents[0], providerId: "memory-model", model: "fake-model" }) });
    await request("/api/lark-bots", { method: "POST", body: JSON.stringify({ name: "MemoryBot", appId: "cli_memory", appSecret: "fake-secret", agentId, openId: "ou_memory_bot", enabled: true }) });

    await request("/feishu/events/usr_owner", { method: "POST", body: JSON.stringify(event("user_message_1", "@_user_1 Please add these rules to the action guide.")) });
    await waitFor(() => modelCalls.length === 1 && replyCount === 1, "first assistant reply");
    await request("/feishu/events/usr_owner", { method: "POST", body: JSON.stringify(event("user_message_2", "@_user_1 Confirmed. Notify everyone.", "bot_reply_1")) });
    await waitFor(() => modelCalls.length === 2 && replyCount === 2, "contextual assistant reply");

    const secondPrompt = modelCalls[1].messages.map((item) => item.content).join("\n");
    if (!secondPrompt.includes("Please add these rules to the action guide.")) throw new Error("Previous user turn was missing from model context.");
    if (!secondPrompt.includes("Rules are complete and ready for confirmation.")) throw new Error("Previous assistant turn was missing from model context.");
    if (!secondPrompt.includes("quoted by current message")) throw new Error("Feishu parent_id was not linked to the quoted assistant turn.");
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "workspaces", "usr_owner", "studio.json"), "utf8"));
    const memory = stored.settings.groupKnowledge || [];
    if (!memory.some((item) => item.messageId === "bot_reply_1" && item.senderType === "assistant")) throw new Error("Assistant turn was not persisted in conversation memory.");
    console.log("Feishu conversation memory test passed: user and assistant turns, quoted-message linkage, and workspace-scoped persistence.");
  } finally {
    if (child) child.kill();
    await new Promise((resolve) => fakeServices.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });