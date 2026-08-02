const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-feishu-long-reply-"));
const tonaPort = 17431;
const modelPort = 17432;
const feishuPort = 17433;
const deliveries = [];
const expectedLines = Array.from({ length: 47 }, (_, index) => `第 ${index + 1} 行：长回复回归内容 ${"细节".repeat(20)}`);
expectedLines.push("FINAL-ANSWER-MARKER");
const longReply = expectedLines.join("\n");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } });
    req.on("error", reject);
  });
}

const modelServer = http.createServer(async (req, res) => {
  await readJson(req);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: longReply } }], usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 } }));
});

const feishuServer = http.createServer(async (req, res) => {
  const body = await readJson(req);
  if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ code: 0, tenant_access_token: "fake-token" }));
  }
  if (req.url.startsWith("/open-apis/im/v1/messages/long_reply_source/reply")) {
    deliveries.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ code: 0, data: { message_id: `reply-${deliveries.length}` } }));
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 404, msg: "not found" }));
});

let child;
async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${tonaPort}${route}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForReady() {
  for (let index = 0; index < 50; index += 1) {
    try { if ((await request("/api/health")).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TONA did not become ready");
}

async function waitForDeliveries() {
  for (let index = 0; index < 80; index += 1) {
    if (deliveries.length >= 3 && deliveries.some((delivery) => delivery.content?.includes("FINAL-ANSWER-MARKER"))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${deliveries.length} Feishu deliveries`);
}

(async () => {
  await Promise.all([
    new Promise((resolve) => modelServer.listen(modelPort, "127.0.0.1", resolve)),
    new Promise((resolve) => feishuServer.listen(feishuPort, "127.0.0.1", resolve))
  ]);
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(tonaPort), DATA_DIR: dataDir, TONA_HUB_AUTH_REQUIRED: "false", FEISHU_OPEN_API_BASE: `http://127.0.0.1:${feishuPort}/open-apis` },
    stdio: "ignore"
  });

  try {
    await waitForReady();
    await request("/api/providers", { method: "POST", body: JSON.stringify({ id: "long_reply_provider", name: "Long Reply Provider", type: "openai_compatible", baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: "test-key", defaultModel: "test-model", models: ["test-model"], enabled: true }) });
    await request("/api/agents", { method: "POST", body: JSON.stringify({ id: "long_reply_agent", name: "Long Reply Agent", providerId: "long_reply_provider", model: "test-model", role: "test", style: "test", goals: "test", guardrails: "test", outputFormat: "text", temperature: 0 }) });
    await request("/api/lark-bots", { method: "POST", body: JSON.stringify({ name: "Long Reply Bot", appId: "cli_long_reply", appSecret: "fake-secret", agentId: "long_reply_agent", enabled: true }) });
    await request("/feishu/events/usr_owner", {
      method: "POST",
      body: JSON.stringify({
        header: { event_type: "im.message.receive_v1", app_id: "cli_long_reply" },
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_long_reply_user" } },
          message: { message_id: "long_reply_source", chat_id: "chat_long_reply", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "请给我完整的长方案" }) }
        }
      })
    });

    await waitForDeliveries();
    assert(deliveries.length >= 3, "Long reply was not split into multiple messages");
    const posts = deliveries.map((delivery) => JSON.parse(delivery.content).zh_cn);
    posts.forEach((post, index) => {
      assert(post.content.length <= 20, "A Feishu post exceeded the line chunk limit");
      assert(post.title.includes(`${index + 1}/${posts.length}`), "Multipart title is missing its sequence number");
    });
    const deliveredText = posts.flatMap((post) => post.content.flat().map((item) => item.text || "")).join("\n");
    assert(deliveredText.includes(expectedLines[0]), "The beginning of the answer was lost");
    assert(deliveredText.includes("FINAL-ANSWER-MARKER"), "The end of the answer was truncated");
    assert.equal(expectedLines.every((line) => deliveredText.includes(line)), true, "At least one answer line was lost during chunking");
    console.log(`Feishu long reply test passed: ${expectedLines.length} lines delivered in ${deliveries.length} ordered parts.`);
  } finally {
    child?.kill();
    await Promise.all([
      new Promise((resolve) => modelServer.close(resolve)),
      new Promise((resolve) => feishuServer.close(resolve))
    ]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
