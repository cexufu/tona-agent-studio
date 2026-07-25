
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const tonaPort = 17376;
const feishuPort = 17377;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-server-managed-collab-"));
const deliveries = [];

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });
}
const fakeFeishu = http.createServer(async (req, res) => {
  const body = await readJson(req);
  if (req.url === "/open-apis/auth/v3/tenant_access_token/internal") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ code: 0, tenant_access_token: "fake-token" }));
  }
  if (req.url.startsWith("/open-apis/im/v1/messages/") || req.url.startsWith("/open-apis/im/v1/messages?")) {
    deliveries.push({ path: req.url, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ code: 0, data: { message_id: "fake_" + deliveries.length } }));
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 404 }));
});

function start(server, port) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}
async function request(url, options = {}) {
  const response = await fetch("http://127.0.0.1:" + tonaPort + url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status + ": " + JSON.stringify(body));
  return body;
}
async function ready() {
  for (let i = 0; i < 40; i += 1) {
    try { return await request("/api/state"); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("Server did not start");
}
function storedDb() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "workspaces", "usr_owner", "studio.json"), "utf8"));
}
async function waitFor(check, label) {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for " + label);
}

(async () => {
  let child;
  try {
    await start(fakeFeishu, feishuPort);
    child = spawn(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(tonaPort),
        DATA_DIR: dataDir,
        FEISHU_OPEN_API_BASE: "http://127.0.0.1:" + feishuPort + "/open-apis"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const state = await ready();
    const agents = state.agents.slice(0, 3);
    for (const [index, agent] of agents.entries()) {
      await request("/api/lark-bots", {
        method: "POST",
        body: JSON.stringify({
          name: agent.name,
          appId: "cli_scheduler_" + index,
          appSecret: "secret_" + index,
          agentId: agent.id,
          openId: "ou_scheduler_" + index,
          enabled: true
        })
      });
    }
    const coordinator = agents[0];
    const writer = agents[2];
    const taskText = "@_user_1 协作任务：协调：" + coordinator.name + "；参与：" + agents.map((agent) => agent.name).join("、") + "；执笔：" + writer.name + "；轮次：2；任务：为一个新研究项目提出可执行的推进计划";
    await request("/feishu/events/usr_owner", {
      method: "POST",
      body: JSON.stringify({
        header: { event_type: "im.message.receive_v1", app_id: "cli_scheduler_0" },
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_scheduler_user" } },
          message: {
            message_id: "server_managed_task",
            chat_id: "chat_scheduler",
            chat_type: "group",
            message_type: "text",
            mentions: [{ name: coordinator.name, id: { open_id: "ou_scheduler_0" } }],
            content: JSON.stringify({ text: taskText })
          }
        }
      })
    });
    await waitFor(() => {
      const task = (storedDb().settings.collaborationTasks || []).find((item) => item.sourceMessageId === "server_managed_task");
      return task?.status === "completed";
    }, "server-managed task completion");
    const task = (storedDb().settings.collaborationTasks || []).find((item) => item.sourceMessageId === "server_managed_task");
    if (task.contributions.length !== task.sequence.length || task.messageCount !== task.sequence.length) throw new Error("Scheduler did not execute every controlled contribution");
    if (deliveries.length !== task.sequence.length) throw new Error("Expected one Feishu delivery per collaboration contribution");
    if (!deliveries[0].path.includes("/reply")) throw new Error("The coordinator should reply to the initiating task message");
    if (deliveries.slice(1).some((delivery) => !delivery.path.includes("receive_id_type=chat_id"))) throw new Error("Follow-up roles were not sent directly to the group");
    if (!deliveries.at(-1).body.content.includes("协作交付")) throw new Error("Final writer did not send the visible delivery");
    const expectedMentions = task.sequence.map((agentId, index) => index === task.sequence.length - 1 ? "ou_scheduler_user" : "ou_scheduler_" + agents.findIndex((agent) => agent.id === task.sequence[index + 1]));
    for (const [index, delivery] of deliveries.entries()) {
      if (delivery.body.msg_type !== "post") throw new Error("Collaboration delivery did not use a rich-text @ message");
      const post = JSON.parse(delivery.body.content);
      const atElement = (post.zh_cn?.content || []).flat().find((item) => item.tag === "at");
      if (!atElement || atElement.user_id !== expectedMentions[index]) throw new Error("Collaboration handoff did not @ the expected next participant");
    }
    console.log("Server-managed collaboration test passed: every scheduled role delivered a real @ handoff and the final synthesis @ mentioned the requester.");
  } finally {
    if (child) child.kill();
    await new Promise((resolve) => fakeFeishu.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
